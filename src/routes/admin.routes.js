const express = require('express');
const router = express.Router();

const controller = require('../controllers/invite.controller');
const adminAuth = require('../middleware/adminAuth');

router.post('/generate-invite', adminAuth, controller.generateInvite);
router.post('/generate-invites', adminAuth, controller.generateInvites);

router.get('/invites', adminAuth, controller.getInvites);
router.get('/invites/status/:status', adminAuth, controller.getByStatus);

router.post('/invites/:inviteId/send-edit', adminAuth, controller.sendEditInvite);

module.exports = router;