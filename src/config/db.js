const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const uri =
      process.env.NODE_ENV === 'production'
        ? process.env.MONGO_URI_PROD
        : process.env.MONGO_URI_DEV;

    await mongoose.connect(uri);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('DB ERROR:', err.message);
    process.exit(1);
  }
};

module.exports = connectDB;