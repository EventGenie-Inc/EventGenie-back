const express = require('express');
const router = express.Router();

const controller = require('../controllers/rsvp.controller');

router.post('/rsvp', controller.submitRSVP);

module.exports = router;