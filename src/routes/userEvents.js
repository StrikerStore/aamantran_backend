const express = require('express');
const verifyUserJWT = require('../middleware/userAuth');
const uploadUserMedia = require('../middleware/uploadUserMedia');
const c = require('../controllers/userDashboard.controller');
const p = require('../controllers/planning.controller');

const router = express.Router();
router.use(verifyUserJWT);

function maybeUserMediaUpload(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    return uploadUserMedia.single('file')(req, res, next);
  }
  next();
}

// ── Events ───────────────────────────────────────────────────────────────────
router.get ('/',                              c.listEvents);
router.post('/',                              c.createEvent);
router.get ('/:id/preview-token',             c.getPreviewToken);
router.get ('/:id',                           c.getEvent);
router.put ('/:id',                           c.updateEvent);
router.patch('/:id/confirm-names',            c.confirmNames);
router.patch('/:id/publish',                  c.publishEvent);
router.patch('/:id/partial-functions',        c.updatePartialFunctions);
router.patch('/:id/unpublish',                c.unpublishEvent);
router.get ('/:id/stats',                     c.getEventStats);

// ── People ───────────────────────────────────────────────────────────────────
router.get   ('/:id/people',                  c.listPeople);
router.post  ('/:id/people',                  c.addPerson);
router.put   ('/:id/people/:pid',             c.updatePerson);
router.delete('/:id/people/:pid',             c.deletePerson);

// ── Functions ────────────────────────────────────────────────────────────────
router.get   ('/:id/functions',               c.listFunctions);
router.post  ('/:id/functions',               c.addFunction);
router.put   ('/:id/functions/:fnId',         c.updateFunction);
router.delete('/:id/functions/:fnId',         c.deleteFunction);

// ── Venues ───────────────────────────────────────────────────────────────────
router.get   ('/:id/venues',                  c.listVenues);
router.post  ('/:id/venues',                  c.addVenue);
router.put   ('/:id/venues/:vId',             c.updateVenue);
router.delete('/:id/venues/:vId',             c.deleteVenue);

// ── Custom Fields ────────────────────────────────────────────────────────────
router.get('/:id/custom-fields',              c.getCustomFields);
router.put('/:id/custom-fields',              c.upsertCustomFields);

// ── Media ────────────────────────────────────────────────────────────────────
router.get   ('/:id/media',                   c.listMedia);
router.post  ('/:id/media', maybeUserMediaUpload, c.uploadMedia);
router.delete('/:id/media/:mediaId',          c.deleteMedia);

// ── Guests ───────────────────────────────────────────────────────────────────
router.get('/:id/guests',                     c.listGuests);
router.get('/:id/guests/export',              c.exportGuestsCSV);

// ── Guest Wishes ─────────────────────────────────────────────────────────────
router.get   ('/:id/wishes',                  c.listWishes);
router.patch ('/:id/wishes/:wishId/visibility', c.setWishVisibility);
router.delete('/:id/wishes/:wishId',          c.deleteWish);

// ── Tasks ────────────────────────────────────────────────────────────────────
router.get   ('/:id/tasks',                   p.listTasks);
router.post  ('/:id/tasks',                   p.createTask);
router.patch ('/:id/tasks/:tid',              p.updateTask);
router.delete('/:id/tasks/:tid',              p.deleteTask);

// ── Inventory ────────────────────────────────────────────────────────────────
router.get   ('/:id/inventory',               p.listInventory);
router.post  ('/:id/inventory',               p.createInventoryItem);
router.patch ('/:id/inventory/:iid',          p.updateInventoryItem);
router.delete('/:id/inventory/:iid',          p.deleteInventoryItem);

// ── Budget ───────────────────────────────────────────────────────────────────
router.get   ('/:id/budget',                  p.getBudget);
router.put   ('/:id/budget',                  p.setBudgetTotal);
router.get   ('/:id/budget/expenses',         p.listExpenses);
router.post  ('/:id/budget/expenses',         p.addExpense);
router.patch ('/:id/budget/expenses/:xid',    p.updateExpense);
router.delete('/:id/budget/expenses/:xid',    p.deleteExpense);

// ── Vendors ──────────────────────────────────────────────────────────────────
router.get   ('/:id/vendors',                 p.listVendors);
router.post  ('/:id/vendors',                 p.createVendor);
router.patch ('/:id/vendors/:vid',            p.updateVendor);
router.delete('/:id/vendors/:vid',            p.deleteVendor);

// ── Timeline ─────────────────────────────────────────────────────────────────
router.get   ('/:id/timeline',                p.listTimeline);
router.post  ('/:id/timeline',                p.createTimelineEntry);
router.patch ('/:id/timeline/:eid',           p.updateTimelineEntry);
router.delete('/:id/timeline/:eid',           p.deleteTimelineEntry);

// ── Mood Board ───────────────────────────────────────────────────────────────
router.get   ('/:id/moodboard',               p.listMoodBoard);
router.post  ('/:id/moodboard', maybeUserMediaUpload, p.createMoodBoardPin);
router.delete('/:id/moodboard/:mid',          p.deleteMoodBoardPin);

// ── Gifts ────────────────────────────────────────────────────────────────────
router.get   ('/:id/gifts',                   p.listGifts);
router.post  ('/:id/gifts',                   p.createGift);
router.patch ('/:id/gifts/:gid',              p.updateGift);
router.delete('/:id/gifts/:gid',              p.deleteGift);

// ── Photo Wall ───────────────────────────────────────────────────────────────
router.get   ('/:id/photos',                  p.listPhotos);
router.post  ('/:id/photos', maybeUserMediaUpload, p.uploadPhoto);
router.delete('/:id/photos/:pid',             p.deletePhoto);

module.exports = router;

