const express = require('express');
const router = express.Router();

const controller = require('../controllers/rsvp.controller');
const adminAuth = require('../middleware/adminAuth');

router.get('/rsvps', adminAuth, controller.getRSVPs);
router.get('/rsvps/status/:status', adminAuth, controller.getByStatus);
router.delete('/rsvps/:rsvpId', adminAuth, controller.deleteRSVP);

module.exports = router;