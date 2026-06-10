const express = require('express');
const fs = require('fs');
const router = express.Router();
const audit = require('../audit');
router.get('/', (req, res) => {
  const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200); let rows = [];
  try { const raw = fs.readFileSync(audit.AUDIT_FILE, 'utf8').trim(); if (raw) rows = raw.split('\n').slice(-limit).map(line => { try { return JSON.parse(line); } catch(e) { return { event:'parse_failed', raw:line }; } }).reverse(); } catch(e) {}
  res.json({ ok:true, total:rows.length, logs:rows, file:audit.AUDIT_FILE });
});
module.exports = router;
