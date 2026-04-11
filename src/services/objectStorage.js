const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutBucketCorsCommand,
} = require('@aws-sdk/client-s3');
const storage = require('../config/storage');

let client;

function getClient() {
  if (!storage.useObjectStorage()) return null;
  if (!client) {
    const accountId = storage.r2AccountId();
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: storage.r2AccessKeyId(),
        secretAccessKey: storage.r2SecretAccessKey(),
      },
    });
  }
  return client;
}

function streamToBuffer(body) {
  if (!body) return Promise.resolve(Buffer.alloc(0));
  if (Buffer.isBuffer(body)) return Promise.resolve(body);
  if (body instanceof Uint8Array) return Promise.resolve(Buffer.from(body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    body.on('data', (c) => chunks.push(c));
    body.on('end', () => resolve(Buffer.concat(chunks)));
    body.on('error', reject);
  });
}

async function putObject(key, body, contentType) {
  const c = getClient();
  if (!c) throw new Error('Object storage is not configured');
  const bucket = storage.r2BucketName();
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    })
  );
}

async function getObjectBuffer(key) {
  const c = getClient();
  if (!c) throw new Error('Object storage is not configured');
  const out = await c.send(
    new GetObjectCommand({
      Bucket: storage.r2BucketName(),
      Key: key,
    })
  );
  return streamToBuffer(out.Body);
}

async function deleteObjectKey(key) {
  const c = getClient();
  if (!c) return;
  await c.send(
    new DeleteObjectCommand({
      Bucket: storage.r2BucketName(),
      Key: key,
    })
  );
}

/** Delete every object under prefix (e.g. templates/my-slug/). */
async function deleteByPrefix(prefix) {
  const c = getClient();
  if (!c) return;
  const bucket = storage.r2BucketName();
  let continuationToken;
  do {
    const listed = await c.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    const contents = listed.Contents || [];
    if (contents.length) {
      await c.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: contents.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        })
      );
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function tryDeletePublicUrl(url) {
  const key = storage.publicUrlToObjectKey(url);
  if (!key) return;
  await deleteObjectKey(key);
}

/**
 * Apply a CORS policy to the R2 bucket so browsers can load template
 * assets (JS, CSS) cross-origin when the invite is served from the API domain.
 *
 * Call once at startup (server.js). Safe to call repeatedly — R2 replaces
 * the policy atomically. No-ops if object storage is not configured.
 */
async function ensureBucketCors() {
  const c = getClient();
  if (!c) return; // local disk mode — no R2

  // Collect all origins that are legitimately allowed to load R2 assets.
  const siteUrls = require('../config/siteUrls');
  const rawOrigins = [
    siteUrls.apiBaseUrl(),
    siteUrls.landingUrl(),
    siteUrls.adminUrl(),
    siteUrls.coupleDashboardUrl(),
    process.env.R2_PUBLIC_BASE_URL,
  ].filter(Boolean);

  // Convert full URLs to origins (scheme + host only).
  const origins = Array.from(
    new Set(
      rawOrigins.map((u) => {
        try { return new URL(u).origin; } catch { return null; }
      }).filter(Boolean)
    )
  );

  // Always include wildcard as last-resort fallback so previews in the
  // admin panel work regardless of which domain loads the iframe.
  if (!origins.includes('*')) origins.push('*');

  await c.send(
    new PutBucketCorsCommand({
      Bucket: storage.r2BucketName(),
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: origins,
            AllowedMethods: ['GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['Content-Length', 'Content-Type'],
            MaxAgeSeconds: 86400,
          },
        ],
      },
    })
  );

  console.log('[R2] CORS policy applied. Allowed origins:', origins.join(', '));
}

module.exports = {
  getClient,
  putObject,
  getObjectBuffer,
  deleteObjectKey,
  deleteByPrefix,
  tryDeletePublicUrl,
  ensureBucketCors,
};
