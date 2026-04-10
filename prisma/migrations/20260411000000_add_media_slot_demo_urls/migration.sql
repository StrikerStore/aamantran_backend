-- TemplateDemoData: JSON map of { slotKey: "https://..." } for demo preview media
ALTER TABLE `TemplateDemoData` ADD COLUMN `mediaSlotDemoUrls` JSON NULL;
