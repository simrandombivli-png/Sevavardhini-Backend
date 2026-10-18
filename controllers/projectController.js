const db = require('../config/db');

const STATUSES = ['Planning', 'Ongoing', 'On_Hold', 'Completed'];
const FIELDS = ['pro_title', 'pro_description', 'pro_domain', 'pro_location',
  'pro_budget', 'pro_status', 'start_date', 'end_date'];

// ---------- validation ----------
const isoDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

const parseProject = (b = {}, partial) => {
  const errors = [];
  const data = {};
  const has = (k) => b[k] !== undefined;

  if (!partial || has('pro_title')) {
    const v = String(b.pro_title ?? '').trim();
    if (!v || v.length > 150) errors.push('pro_title is required (max 150 characters)');
    data.pro_title = v;
  }
  if (has('pro_description')) data.pro_description = b.pro_description === null ? null : String(b.pro_description).trim();
  if (has('pro_domain')) {
    const v = String(b.pro_domain ?? '').trim();
    if (!v || v.length > 100) errors.push('pro_domain must be 1 to 100 characters');
    data.pro_domain = v;
  }
  if (has('pro_location')) {
    const v = b.pro_location === null ? null : String(b.pro_location).trim();
    if (v && v.length > 150) errors.push('pro_location is too long (max 150)');
    data.pro_location = v || null;
  }
  if (has('pro_budget')) {
    const v = b.pro_budget === null || b.pro_budget === '' ? null : Number(b.pro_budget);
    if (v !== null && (!Number.isFinite(v) || v < 0 || v >= 1e12)) errors.push('pro_budget must be a non-negative number');
    data.pro_budget = v;
  }
  if (has('pro_status')) {
    if (!STATUSES.includes(b.pro_status)) errors.push(`pro_status must be one of: ${STATUSES.join(', ')}`);
    data.pro_status = b.pro_status;
  }
  for (const k of ['start_date', 'end_date']) {
    if (has(k)) {
      if (b[k] !== null && !isoDate(b[k])) errors.push(`${k} must be a valid date in YYYY-MM-DD format`);
      data[k] = b[k];
    }
  }
  if (data.start_date && data.end_date && data.end_date < data.start_date) {
    errors.push('end_date cannot be before start_date');
  }
  if (has('coordinator_ids')) {
    const ids = b.coordinator_ids;
    if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n) && n > 0 && n <= 2147483647)) {
      errors.push('coordinator_ids must be an array of user ids');
    } else {
      data.coordinator_ids = [...new Set(ids)];
    }
  }
  return { errors, data };
};

const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

// ---------- helpers ----------
const PROJECT_SELECT = `
  SELECT p.pro_id, p.pro_title, p.pro_description, p.pro_domain, p.pro_location,
         p.pro_budget::float8 AS pro_budget, p.pro_status,
         p.start_date::text AS start_date, p.end_date::text AS end_date,
         p.pro_managed_by, m.user_name AS manager_name,
         p.pro_created_at, p.pro_updated_at,
         COALESCE(json_agg(json_build_object('user_id', c.user_id, 'user_name', c.user_name))
                  FILTER (WHERE c.user_id IS NOT NULL), '[]') AS coordinators
    FROM projects p
    LEFT JOIN users m ON m.user_id = p.pro_managed_by
    LEFT JOIN project_coordinators pc ON pc.coord_project_id = p.pro_id
    LEFT JOIN users c ON c.user_id = pc.coord_user_id`;
const PROJECT_GROUP = ' GROUP BY p.pro_id, m.user_id ORDER BY p.pro_created_at DESC';

// Which projects the logged-in role may see. Pushes its parameter onto `params`.
const scopeFor = (user, params) => {
  if (user.role === 'Admin') return '';
  params.push(user.user_id);
  const n = params.length;
  if (user.role === 'Project_Manager') return ` AND p.pro_managed_by = $${n}`;
  return ` AND EXISTS (SELECT 1 FROM project_coordinators x
                        WHERE x.coord_project_id = p.pro_id AND x.coord_user_id = $${n})`;
};

const fetchOne = async (id, user) => {
  const params = [id];
  const where = ` WHERE p.pro_id = $1 AND p.pro_is_archived = false${scopeFor(user, params)}`;
  const r = await db.query(PROJECT_SELECT + where + PROJECT_GROUP, params);
  return r.rows[0] || null;
};

const validCoordinators = async (client, ids) => {
  if (!ids.length) return true;
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM users
      WHERE user_id = ANY($1::int[]) AND role = 'Coordinator' AND user_is_active = true`,
    [ids]
  );
  return r.rows[0].n === ids.length;
};

const setCoordinators = async (client, projectId, ids) => {
  await client.query('DELETE FROM project_coordinators WHERE coord_project_id = $1', [projectId]);
  if (ids.length) {
    await client.query(
      `INSERT INTO project_coordinators (coord_project_id, coord_user_id)
       SELECT $1, unnest($2::int[])`,
      [projectId, ids]
    );
  }
};

const audit = (client, userId, action, entityId, details) =>
  client.query(
    `INSERT INTO audit_logs (log_user_id, log_action, log_entity_type, log_entity_id, log_details)
     VALUES ($1, $2, 'project', $3, $4)`,
    [userId, action, entityId, JSON.stringify(details)]
  );

// ---------- handlers ----------
const listProjects = async (req, res) => {
  try {
    const params = [];
    let where = ' WHERE p.pro_is_archived = false' + scopeFor(req.user, params);

    const { status, q } = req.query;
    if (status) {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status filter' });
      }
      params.push(status);
      where += ` AND p.pro_status = $${params.length}`;
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`);
      const n = params.length;
      where += ` AND (p.pro_title ILIKE $${n} OR p.pro_location ILIKE $${n} OR p.pro_domain ILIKE $${n}
                 OR EXISTS (SELECT 1 FROM project_coordinators y JOIN users yu ON yu.user_id = y.coord_user_id
                             WHERE y.coord_project_id = p.pro_id AND yu.user_name ILIKE $${n}))`;
    }

    const r = await db.query(PROJECT_SELECT + where + PROJECT_GROUP, params);
    res.json({ success: true, projects: r.rows });
  } catch (error) {
    console.error('List Projects Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const getProject = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid project id' });
    const project = await fetchOne(id, req.user);
    if (!project) return res.status(404).json({ success: false, message: 'Project not found' });
    res.json({ success: true, project });
  } catch (error) {
    console.error('Get Project Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Active coordinators for the "New project" form dropdown (Project Manager only)
const listCoordinators = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT user_id, user_name FROM users
        WHERE role = 'Coordinator' AND user_is_active = true ORDER BY user_name`
    );
    res.json({ success: true, coordinators: r.rows });
  } catch (error) {
    console.error('List Coordinators Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const createProject = async (req, res) => {
  const { errors, data } = parseProject(req.body, false);
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
  const coordinatorIds = data.coordinator_ids || [];

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await validCoordinators(client, coordinatorIds))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Every coordinator must be an active user with the Coordinator role' });
    }

    const ins = await client.query(
      `INSERT INTO projects (pro_title, pro_description, pro_domain, pro_location, pro_budget,
                             pro_status, start_date, end_date, pro_managed_by)
       VALUES ($1, $2, COALESCE($3, 'General'), $4, $5, COALESCE($6, 'Planning'), $7, $8, $9)
       RETURNING pro_id`,
      [data.pro_title, data.pro_description ?? null, data.pro_domain ?? null, data.pro_location ?? null,
       data.pro_budget ?? null, data.pro_status ?? null, data.start_date ?? null, data.end_date ?? null,
       req.user.user_id]
    );
    const id = ins.rows[0].pro_id;
    await setCoordinators(client, id, coordinatorIds);
    await audit(client, req.user.user_id, 'CREATE', id, { pro_title: data.pro_title });
    await client.query('COMMIT');

    res.status(201).json({ success: true, project: await fetchOne(id, req.user) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23514') {
      return res.status(400).json({ success: false, message: 'end_date cannot be before start_date' });
    }
    console.error('Create Project Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
};

const updateProject = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid project id' });

  const { errors, data } = parseProject(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

  const sets = [];
  const params = [];
  for (const f of FIELDS) {            // FIELDS is a fixed whitelist, so column names are safe
    if (f in data) { params.push(data[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length && !data.coordinator_ids) {
    return res.status(400).json({ success: false, message: 'Nothing to update' });
  }
  sets.push('pro_updated_at = NOW()');
  params.push(id, req.user.user_id);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (data.coordinator_ids && !(await validCoordinators(client, data.coordinator_ids))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Every coordinator must be an active user with the Coordinator role' });
    }

    const upd = await client.query(
      `UPDATE projects SET ${sets.join(', ')}
        WHERE pro_id = $${params.length - 1} AND pro_managed_by = $${params.length}
          AND pro_is_archived = false
        RETURNING pro_id`,
      params
    );
    if (!upd.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Project not found' });
    }
    if (data.coordinator_ids) await setCoordinators(client, id, data.coordinator_ids);

    await audit(client, req.user.user_id, 'UPDATE', id, { changed: Object.keys(data) });
    await client.query('COMMIT');

    res.json({ success: true, project: await fetchOne(id, req.user) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23514') {
      return res.status(400).json({ success: false, message: 'end_date cannot be before start_date' });
    }
    console.error('Update Project Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// "Delete" = archive, so tasks and reports keep their parent project
const archiveProject = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid project id' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE projects
          SET pro_is_archived = true, pro_archived_at = NOW(), pro_archived_by = $2, pro_updated_at = NOW()
        WHERE pro_id = $1 AND pro_managed_by = $2 AND pro_is_archived = false
        RETURNING pro_id`,
      [id, req.user.user_id]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Project not found' });
    }
    await audit(client, req.user.user_id, 'ARCHIVE', id, {});
    await client.query('COMMIT');
    res.json({ success: true, message: 'Project deleted' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Archive Project Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
};

module.exports = { listProjects, getProject, listCoordinators, createProject, updateProject, archiveProject };