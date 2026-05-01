const prisma = require('../utils/prisma');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ownerGuard(event, userId) {
  return event && event.ownerId === userId;
}

async function getEventForUser(req) {
  const event = await prisma.event.findUnique({
    where: { id: req.params.id },
    select: { id: true, ownerId: true },
  });
  if (!ownerGuard(event, req.user.id)) return null;
  return event;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════

async function listTasks(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const tasks = await prisma.task.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'asc' } });
  return res.json({ ok: true, tasks });
}

async function createTask(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const { title, category, dueDate, priority, assignedTo, status, notes } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, message: 'title is required' });
  const task = await prisma.task.create({
    data: {
      eventId: req.params.id, title,
      category: category || 'Other', dueDate: dueDate || null,
      priority: priority || 'medium', assignedTo: assignedTo || null,
      status: status || 'todo', notes: notes || null,
    },
  });
  return res.status(201).json({ ok: true, task });
}

async function updateTask(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const { title, category, dueDate, priority, assignedTo, status, notes } = req.body || {};
  const data = {};
  if (title !== undefined) data.title = title;
  if (category !== undefined) data.category = category;
  if (dueDate !== undefined) data.dueDate = dueDate || null;
  if (priority !== undefined) data.priority = priority;
  if (assignedTo !== undefined) data.assignedTo = assignedTo || null;
  if (status !== undefined) data.status = status;
  if (notes !== undefined) data.notes = notes || null;
  const task = await prisma.task.update({ where: { id: req.params.tid }, data });
  return res.json({ ok: true, task });
}

async function deleteTask(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.task.delete({ where: { id: req.params.tid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════════════════════════

async function listInventory(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const items = await prisma.inventoryItem.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'asc' } });
  return res.json({ ok: true, items });
}

async function createInventoryItem(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ ok: false, message: 'name is required' });
  const item = await prisma.inventoryItem.create({
    data: {
      eventId: req.params.id, name: b.name,
      category: b.category || 'Other', subCategory: b.subCategory || null,
      quantity: b.quantity ? parseInt(b.quantity, 10) : 1, unit: b.unit || 'pcs',
      status: b.status || 'to-buy', location: b.location || null,
      assignedTo: b.assignedTo || null, vendor: b.vendor || null,
      estimatedCost: b.estimatedCost ? parseFloat(b.estimatedCost) : null,
      actualCost: b.actualCost ? parseFloat(b.actualCost) : null,
      reminderDate: b.reminderDate || null, reminderNote: b.reminderNote || null,
      notes: b.notes || null,
    },
  });
  return res.status(201).json({ ok: true, item });
}

async function updateInventoryItem(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.category !== undefined) data.category = b.category;
  if (b.subCategory !== undefined) data.subCategory = b.subCategory || null;
  if (b.quantity !== undefined) data.quantity = parseInt(b.quantity, 10) || 1;
  if (b.unit !== undefined) data.unit = b.unit || 'pcs';
  if (b.status !== undefined) data.status = b.status;
  if (b.location !== undefined) data.location = b.location || null;
  if (b.assignedTo !== undefined) data.assignedTo = b.assignedTo || null;
  if (b.vendor !== undefined) data.vendor = b.vendor || null;
  if (b.estimatedCost !== undefined) data.estimatedCost = b.estimatedCost ? parseFloat(b.estimatedCost) : null;
  if (b.actualCost !== undefined) data.actualCost = b.actualCost ? parseFloat(b.actualCost) : null;
  if (b.reminderDate !== undefined) data.reminderDate = b.reminderDate || null;
  if (b.reminderNote !== undefined) data.reminderNote = b.reminderNote || null;
  if (b.notes !== undefined) data.notes = b.notes || null;
  const item = await prisma.inventoryItem.update({ where: { id: req.params.iid }, data });
  return res.json({ ok: true, item });
}

async function deleteInventoryItem(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.inventoryItem.delete({ where: { id: req.params.iid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGET
// ═══════════════════════════════════════════════════════════════════════════════

async function getBudget(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  let budget = await prisma.eventBudget.findUnique({ where: { eventId: req.params.id } });
  if (!budget) budget = { totalBudget: 0 };
  return res.json({ ok: true, budget });
}

async function setBudgetTotal(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const { totalBudget } = req.body || {};
  if (totalBudget === undefined) return res.status(400).json({ ok: false, message: 'totalBudget is required' });
  const budget = await prisma.eventBudget.upsert({
    where: { eventId: req.params.id },
    create: { eventId: req.params.id, totalBudget: parseFloat(totalBudget) },
    update: { totalBudget: parseFloat(totalBudget) },
  });
  return res.json({ ok: true, budget });
}

async function listExpenses(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const expenses = await prisma.budgetExpense.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'asc' } });
  return res.json({ ok: true, expenses });
}

async function addExpense(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  if (!b.description || !b.amount) return res.status(400).json({ ok: false, message: 'description and amount are required' });
  const expense = await prisma.budgetExpense.create({
    data: {
      eventId: req.params.id, description: b.description,
      category: b.category || 'Other', vendor: b.vendor || null,
      amount: parseFloat(b.amount), paid: Boolean(b.paid),
      dueDate: b.dueDate || null, notes: b.notes || null,
    },
  });
  return res.status(201).json({ ok: true, expense });
}

async function updateExpense(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  const data = {};
  if (b.description !== undefined) data.description = b.description;
  if (b.category !== undefined) data.category = b.category;
  if (b.vendor !== undefined) data.vendor = b.vendor || null;
  if (b.amount !== undefined) data.amount = parseFloat(b.amount);
  if (b.paid !== undefined) data.paid = Boolean(b.paid);
  if (b.dueDate !== undefined) data.dueDate = b.dueDate || null;
  if (b.notes !== undefined) data.notes = b.notes || null;
  const expense = await prisma.budgetExpense.update({ where: { id: req.params.xid }, data });
  return res.json({ ok: true, expense });
}

async function deleteExpense(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.budgetExpense.delete({ where: { id: req.params.xid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VENDORS
// ═══════════════════════════════════════════════════════════════════════════════

async function listVendors(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const vendors = await prisma.eventVendor.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'asc' } });
  return res.json({ ok: true, vendors });
}

async function createVendor(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ ok: false, message: 'name is required' });
  const vendor = await prisma.eventVendor.create({
    data: {
      eventId: req.params.id, name: b.name,
      type: b.type || 'Other', contactName: b.contactName || null,
      phone: b.phone || null, email: b.email || null,
      website: b.website || null, packageName: b.packageName || null,
      packageCost: b.packageCost ? parseFloat(b.packageCost) : null,
      depositPaid: b.depositPaid ? parseFloat(b.depositPaid) : null,
      totalPaid: b.totalPaid ? parseFloat(b.totalPaid) : null,
      status: b.status || 'contacted', bookingDate: b.bookingDate || null,
      notes: b.notes || null,
    },
  });
  return res.status(201).json({ ok: true, vendor });
}

async function updateVendor(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  const data = {};
  for (const k of ['name','type','contactName','phone','email','website','packageName','status','bookingDate','notes']) {
    if (b[k] !== undefined) data[k] = b[k] || null;
  }
  if (b.name !== undefined) data.name = b.name; // name should not be null
  for (const k of ['packageCost','depositPaid','totalPaid']) {
    if (b[k] !== undefined) data[k] = b[k] ? parseFloat(b[k]) : null;
  }
  const vendor = await prisma.eventVendor.update({ where: { id: req.params.vid }, data });
  return res.json({ ok: true, vendor });
}

async function deleteVendor(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.eventVendor.delete({ where: { id: req.params.vid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════════════════════════════════════════

async function listTimeline(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const entries = await prisma.timelineEntry.findMany({ where: { eventId: req.params.id }, orderBy: { sortOrder: 'asc' } });
  return res.json({ ok: true, entries });
}

async function createTimelineEntry(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  if (!b.time || !b.title) return res.status(400).json({ ok: false, message: 'time and title are required' });
  const entry = await prisma.timelineEntry.create({
    data: {
      eventId: req.params.id, functionId: b.functionId || null,
      time: b.time, title: b.title,
      location: b.location || null, responsiblePerson: b.responsiblePerson || null,
      duration: b.duration || null, notes: b.notes || null,
      sortOrder: b.sortOrder ?? 0,
    },
  });
  return res.status(201).json({ ok: true, entry });
}

async function updateTimelineEntry(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  const data = {};
  if (b.functionId !== undefined) data.functionId = b.functionId || null;
  if (b.time !== undefined) data.time = b.time;
  if (b.title !== undefined) data.title = b.title;
  if (b.location !== undefined) data.location = b.location || null;
  if (b.responsiblePerson !== undefined) data.responsiblePerson = b.responsiblePerson || null;
  if (b.duration !== undefined) data.duration = b.duration || null;
  if (b.notes !== undefined) data.notes = b.notes || null;
  if (b.sortOrder !== undefined) data.sortOrder = b.sortOrder;
  const entry = await prisma.timelineEntry.update({ where: { id: req.params.eid }, data });
  return res.json({ ok: true, entry });
}

async function deleteTimelineEntry(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.timelineEntry.delete({ where: { id: req.params.eid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOOD BOARD
// ═══════════════════════════════════════════════════════════════════════════════

async function listMoodBoard(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const pins = await prisma.moodBoardPin.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'desc' } });
  return res.json({ ok: true, pins });
}

async function createMoodBoardPin(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });

  let imageUrl = '';
  const storage = require('../config/storage');

  if (req.file) {
    // File uploaded via multer
    if (storage.useObjectStorage()) {
      const objectStorage = require('../services/objectStorage');
      const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
      const key = `moodboard/${req.params.id}/${uuidv4()}${ext}`;
      const ct = storage.contentTypeForPath(req.file.originalname || `file${ext}`);
      const fs = require('fs');
      const buffer = fs.readFileSync(req.file.path);
      await objectStorage.putObject(key, buffer, ct);
      imageUrl = `${storage.objectStoragePublicBase()}/${key}`;
      fs.unlinkSync(req.file.path);
    } else {
      imageUrl = `/uploads/${req.file.filename}`;
    }
  } else {
    imageUrl = (req.body?.imageUrl || '').trim();
  }

  if (!imageUrl) return res.status(400).json({ ok: false, message: 'Image file or URL is required' });

  const caption = req.body?.caption || null;
  const category = req.body?.category || 'Other';

  const pin = await prisma.moodBoardPin.create({
    data: { eventId: req.params.id, imageUrl, caption, category },
  });
  return res.status(201).json({ ok: true, pin });
}

async function deleteMoodBoardPin(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.moodBoardPin.delete({ where: { id: req.params.mid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIFTS
// ═══════════════════════════════════════════════════════════════════════════════

async function listGifts(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const gifts = await prisma.gift.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'desc' } });
  return res.json({ ok: true, gifts });
}

async function createGift(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  if (!b.fromName) return res.status(400).json({ ok: false, message: 'fromName is required' });
  const gift = await prisma.gift.create({
    data: {
      eventId: req.params.id, fromName: b.fromName,
      fromRelation: b.fromRelation || null,
      giftDescription: b.giftDescription || null,
      receivedDate: b.receivedDate || null,
      estimatedValue: b.estimatedValue ? parseFloat(b.estimatedValue) : null,
      thankYouSent: Boolean(b.thankYouSent),
      notes: b.notes || null,
    },
  });
  return res.status(201).json({ ok: true, gift });
}

async function updateGift(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const b = req.body || {};
  const data = {};
  if (b.fromName !== undefined) data.fromName = b.fromName;
  if (b.fromRelation !== undefined) data.fromRelation = b.fromRelation || null;
  if (b.giftDescription !== undefined) data.giftDescription = b.giftDescription || null;
  if (b.receivedDate !== undefined) data.receivedDate = b.receivedDate || null;
  if (b.estimatedValue !== undefined) data.estimatedValue = b.estimatedValue ? parseFloat(b.estimatedValue) : null;
  if (b.thankYouSent !== undefined) data.thankYouSent = Boolean(b.thankYouSent);
  if (b.notes !== undefined) data.notes = b.notes || null;
  const gift = await prisma.gift.update({ where: { id: req.params.gid }, data });
  return res.json({ ok: true, gift });
}

async function deleteGift(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.gift.delete({ where: { id: req.params.gid } });
  return res.json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHOTO WALL
// ═══════════════════════════════════════════════════════════════════════════════

async function listPhotos(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  const photos = await prisma.photoWallItem.findMany({ where: { eventId: req.params.id }, orderBy: { createdAt: 'desc' } });
  return res.json({ ok: true, photos });
}

async function uploadPhoto(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  if (!req.file) return res.status(400).json({ ok: false, message: 'Image file is required' });

  let url = '';
  const storage = require('../config/storage');

  if (storage.useObjectStorage()) {
    const objectStorage = require('../services/objectStorage');
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    const key = `photowall/${req.params.id}/${uuidv4()}${ext}`;
    const ct = storage.contentTypeForPath(req.file.originalname || `file${ext}`);
    const fs = require('fs');
    const buffer = fs.readFileSync(req.file.path);
    await objectStorage.putObject(key, buffer, ct);
    url = `${storage.objectStoragePublicBase()}/${key}`;
    fs.unlinkSync(req.file.path);
  } else {
    url = `/uploads/${req.file.filename}`;
  }

  const category = req.body?.category || 'Ceremony';
  const caption = req.body?.caption || null;

  const photo = await prisma.photoWallItem.create({
    data: { eventId: req.params.id, url, caption, category },
  });
  return res.status(201).json({ ok: true, photo });
}

async function deletePhoto(req, res) {
  if (!(await getEventForUser(req))) return res.status(404).json({ ok: false, message: 'Event not found' });
  await prisma.photoWallItem.delete({ where: { id: req.params.pid } });
  return res.json({ ok: true });
}

module.exports = {
  // Tasks
  listTasks, createTask, updateTask, deleteTask,
  // Inventory
  listInventory, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  // Budget
  getBudget, setBudgetTotal, listExpenses, addExpense, updateExpense, deleteExpense,
  // Vendors
  listVendors, createVendor, updateVendor, deleteVendor,
  // Timeline
  listTimeline, createTimelineEntry, updateTimelineEntry, deleteTimelineEntry,
  // Mood Board
  listMoodBoard, createMoodBoardPin, deleteMoodBoardPin,
  // Gifts
  listGifts, createGift, updateGift, deleteGift,
  // Photo Wall
  listPhotos, uploadPhoto, deletePhoto,
};
