const inviteRoutes = require('./routes/invite.routes');
const adminRoutes = require('./routes/admin.routes');
const rsvpRoutes = require('./routes/rsvp.routes');
const rsvpAdminRoutes = require('./routes/rsvpAdmin.routes');
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', inviteRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/event2', rsvpRoutes);
app.use('/api/event2/admin', rsvpAdminRoutes);

app.use('/api/reports', require('./routes/report.routes'));

module.exports = app;