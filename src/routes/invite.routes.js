const express = require('express');
const router = express.Router();

const controller = require('../controllers/invite.controller');

router.get('/validate-token/:token', controller.validateToken);
router.post('/rsvp', controller.submitRSVP);

router.get('/validate-edit-token/:token', controller.validateEditToken);
router.post('/update-rsvp', controller.updateRSVP);

module.exports = router;