const express = require('express');

function createFindingsRouter({ db }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const findings = db.prepare('SELECT * FROM long_term_findings WHERE is_archived = 0 ORDER BY updated_at DESC, created_at DESC').all();
    res.json(findings);
  });

  router.post('/', (req, res) => {
    const content = String(req.body?.content || '').trim();
    const source = String(req.body?.source || 'nora').trim() || 'nora';
    if (!content) return res.status(400).json({ error: 'content is required' });

    try {
      const result = db.prepare('INSERT INTO long_term_findings (content, source, is_archived, updated_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)')
        .run(content, source);
      const finding = db.prepare('SELECT * FROM long_term_findings WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, finding });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) {
        const existing = db.prepare('SELECT * FROM long_term_findings WHERE content = ?').get(content);
        return res.json({ success: true, finding: existing, duplicate: true });
      }
      res.status(500).json({ error: err.message || 'Failed to add finding' });
    }
  });

  router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content is required' });

    const existing = db.prepare('SELECT * FROM long_term_findings WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Finding not found' });

    db.prepare('UPDATE long_term_findings SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, id);
    const updated = db.prepare('SELECT * FROM long_term_findings WHERE id = ?').get(id);
    res.json({ success: true, finding: updated });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE long_term_findings SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    res.json({ success: true });
  });

  return router;
}

module.exports = {
  createFindingsRouter,
};
