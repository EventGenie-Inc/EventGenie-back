const express = require('express');
const router = express.Router();

const reportController = require('../controllers/report.controller');
const apiKey = require('../middleware/apiKey');


router.get('/summary',apiKey, reportController.getSummary);
router.get('/attendance',apiKey, reportController.getAttendance);
router.get('/timeseries',apiKey, reportController.getTimeSeries);

module.exports = router;