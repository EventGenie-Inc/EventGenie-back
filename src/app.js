const inviteRoutes = require('./routes/invite.routes');
const adminRoutes = require('./routes/admin.routes');
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());

app.use(express.json());


app.use('/api', inviteRoutes);

app.use('/api/admin', adminRoutes);

module.exports = app;