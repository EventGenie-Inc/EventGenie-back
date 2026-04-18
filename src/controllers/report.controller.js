const Invite = require('../models/invite.model');


exports.getSummary = async (req, res) => {
  try {
    const result = await Invite.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          status: "$_id",
          count: 1
        }
      }
    ]);

    res.json(result);
  } catch (err) {
    console.error('Summary error:', err);
    res.status(500).json({ message: err.message });
  }
};


exports.getAttendance = async (req, res) => {
  try {
    const result = await Invite.aggregate([
      {
        $match: {
          status: "accepted",
          attendance: { $ne: null }
        }
      },
      {
        $group: {
          _id: "$attendance",
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          attendance: "$_id",
          count: 1
        }
      }
    ]);

    res.json(result);
  } catch (err) {
    console.error('Attendance error:', err);
    res.status(500).json({ message: err.message });
  }
};

exports.getTimeSeries = async (req, res) => {
  try {
    const result = await Invite.aggregate([
      {
        $project: {
          createdDate: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
          },
          acceptedFlag: {
            $cond: [{ $eq: ["$status", "accepted"] }, 1, 0]
          }
        }
      },
      {
        $group: {
          _id: "$createdDate",
          created: { $sum: 1 },
          accepted: { $sum: "$acceptedFlag" }
        }
      },
      {
        $project: {
          _id: 0,
          date: "$_id",
          created: 1,
          accepted: 1
        }
      },
      { $sort: { date: 1 } }
    ]);

    res.json(result);
  } catch (err) {
    console.error('TimeSeries error:', err);
    res.status(500).json({ message: err.message });
  }
};