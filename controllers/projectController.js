const db = require('../config/db');

// Keep this list in sync with the CHECK constraint on projects.pro_status in the database.
const STATUSES = ['Planning', 'Ongoing', 'Completed'];
// Fields an Admin or the owning Project Manager may change.
const FIELDS = ['pro_title', 'pro_description', 'pro_domain', 'pro_status', 'start_date', 'end_date'];

// ---------- validation ----------
const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

const isoDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

const parseProject = (b = {}, partial) => {
  const errors = [];
  const data = {};
  const has = (k) => b[k] !== undefined;

  if (!partial || has('pro_title')) {
    const v = typeof b.pro_title === 'string' ? b.pro_title.trim() : '';
    if (!v || v.length > 150) errors.push('pro_title is required (max 150 characters)');
    data.pro_title = v;
  }
  if (has('pro_description')) {
    if (b.pro_description !== null && typeof b.pro_description !== 'string') {
      errors.push('pro_description must be text');
    } else {
      data.pro_description = b.pro_description === null ? null : b.pro_description.trim();
    }
  }
  if (has('pro_domain')) {
    const v = typeof b.pro_domain === 'string' ? b.pro_domain.trim() : '';
    if (!v || v.length > 100) errors.push('pro_domain must be 1 to 100 characters');
    data.pro_domain = v;
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
  // Admin-only fields (the route / handler checks who is allowed to send them)
  if (!partial || has('pro_managed_by')) {
    const n = parseId(b.pro_managed_by);
    if (!n) errors.push('pro_managed_by must be the user id of a Project Manager');
    else data.pro_managed_by = n;
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

// ---------- helpers ----------
const PROJECT_SELECT = `
  SELECT p.pro_id, p.pro_title, p.pro_description, p.pro_domain, p.pro_status,
         p.start_date::text AS start_date, p.end_date::text AS end_date,
         p.pro_managed_by, m.user_name AS manager_name,
         p.pro_created_at, p.pro_updated_at, p.pro_archived_at,
         COALESCE(json_agg(json_build_object('user_id', c.user_id, 'user_name', c.user_name))
                  FILTER (WHERE c.user_id IS NOT NULL), '[]') AS coordinators
    FROM projects p
    LEFT JOIN users m ON m.user_id = p.pro_managed_by
    LEFT JOIN project_coordinators pc ON pc.coord_project_id = p.pro_id
    LEFT JOIN users c ON c.user_id = pc.coord_user_id`;
const PROJECT_GROUP = ' GROUP BY p.pro_id, m.user_id ORDER BY p.pro_created_at DESC';
const ARCHIVED_GROUP = ' GROUP BY p.pro_id, m.user_id ORDER BY p.pro_archived_at DESC';

// Which (non-archived) projects the logged-in role may see. Pushes its parameter onto `params`.
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

const validManager = async (client, id) => {
  const r = await client.query(
    `SELECT 1 FROM users WHERE user_id = $1 AND role = 'Project_Manager' AND user_is_active = true`,
    [id]
  );
  return r.rowCount === 1;
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

// Turns a database error into the right response. Only a CHECK violation (23514) is the
// user's fault, and the message depends on WHICH rule failed. Anything else is a real 500.
const handleError = (res, error, label) => {
  if (error.code === '23514') {
    let message = 'One of the values is not allowed';
    if (error.constraint === 'projects_dates_chk') message = 'end_date cannot be before start_date';
    else if (error.constraint === 'projects_pro_status_check') message = `pro_status must be one of: ${STATUSES.join(', ')}`;
    return res.status(400).json({ success: false, message });
  }
  console.error(`${label} Error:`, error);
  return res.status(500).json({ success: false, message: 'Internal server error' });
};

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
      where += ` AND (p.pro_title ILIKE $${n} OR p.pro_domain ILIKE $${n}
                 OR EXISTS (SELECT 1 FROM project_coordinators y JOIN users yu ON yu.user_id = y.coord_user_id
                             WHERE y.coord_project_id = p.pro_id AND yu.user_name ILIKE $${n}))`;
    }

    const r = await db.query(PROJECT_SELECT + where + PROJECT_GROUP, params);
    res.json({ success: true, projects: r.rows });
  } catch (error) {
    handleError(res, error, 'List Projects');
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
    handleError(res, error, 'Get Project');
  }
};

// Admin only: archived projects (the only place they can be seen)
const listArchived = async (req, res) => {
  try {
    const r = await db.query(PROJECT_SELECT + ' WHERE p.pro_is_archived = true' + ARCHIVED_GROUP);
    res.json({ success: true, projects: r.rows });
  } catch (error) {
    handleError(res, error, 'List Archived');
  }
};

// Admin only: dropdown data for the "New project" / "Edit project" forms
const listCoordinators = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT user_id, user_name FROM users
        WHERE role = 'Coordinator' AND user_is_active = true ORDER BY user_name`
    );
    res.json({ success: true, coordinators: r.rows });
  } catch (error) {
    handleError(res, error, 'List Coordinators');
  }
};

const listManagers = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT user_id, user_name FROM users
        WHERE role = 'Project_Manager' AND user_is_active = true ORDER BY user_name`
    );
    res.json({ success: true, managers: r.rows });
  } catch (error) {
    handleError(res, error, 'List Managers');
  }
};

// Admin only. The Admin picks the Project Manager and the coordinators.
const createProject = async (req, res) => {
  const { errors, data } = parseProject(req.body, false);
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
  const coordinatorIds = data.coordinator_ids || [];

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await validManager(client, data.pro_managed_by))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'pro_managed_by must be an active user with the Project Manager role' });
    }
    if (!(await validCoordinators(client, coordinatorIds))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Every coordinator must be an active user with the Coordinator role' });
    }

    const ins = await client.query(
      `INSERT INTO projects (pro_title, pro_description, pro_domain, pro_status,
                             start_date, end_date, pro_managed_by)
       VALUES ($1, $2, COALESCE($3, 'General'), COALESCE($4, 'Planning'), $5, $6, $7)
       RETURNING pro_id`,
      [data.pro_title, data.pro_description ?? null, data.pro_domain ?? null, data.pro_status ?? null,
       data.start_date ?? null, data.end_date ?? null, data.pro_managed_by]
    );
    const id = ins.rows[0].pro_id;
    await setCoordinators(client, id, coordinatorIds);
    await audit(client, req.user.user_id, 'CREATE', id, { pro_title: data.pro_title });
    await client.query('COMMIT');

    res.status(201).json({ success: true, project: await fetchOne(id, req.user) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, error, 'Create Project');
  } finally {
    client.release();
  }
};

// Admin: any project, and may change the manager and coordinators.
// Project Manager: only their own project, and only the basic fields.
const updateProject = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid project id' });

  const isAdmin = req.user.role === 'Admin';
  const body = req.body || {};
  if (!isAdmin && (body.pro_managed_by !== undefined || body.coordinator_ids !== undefined)) {
    return res.status(403).json({ success: false, message: 'Only an Admin can change the project manager or coordinators' });
  }

  const { errors, data } = parseProject(body, true);
  if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

  const sets = [];
  const params = [];
  const allowed = isAdmin ? [...FIELDS, 'pro_managed_by'] : FIELDS; // fixed whitelist, so column names are safe
  for (const f of allowed) {
    if (f in data) { params.push(data[f]); sets.push(`${f} = $${params.length}`); }
  }
  if (!sets.length && !data.coordinator_ids) {
    return res.status(400).json({ success: false, message: 'Nothing to update' });
  }
  sets.push('pro_updated_at = NOW()');
  params.push(id);
  let where = `pro_id = $${params.length} AND pro_is_archived = false`;
  if (!isAdmin) {                       // a PM can only touch their own project
    params.push(req.user.user_id);
    where += ` AND pro_managed_by = $${params.length}`;
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (data.pro_managed_by && !(await validManager(client, data.pro_managed_by))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'pro_managed_by must be an active user with the Project Manager role' });
    }
    if (data.coordinator_ids && !(await validCoordinators(client, data.coordinator_ids))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Every coordinator must be an active user with the Coordinator role' });
    }

    const upd = await client.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE ${where} RETURNING pro_id`,
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
    handleError(res, error, 'Update Project');
  } finally {
    client.release();
  }
};

// Admin only. "Delete" = archive, so tasks and reports keep their parent project.
const archiveProject = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid project id' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE projects
          SET pro_is_archived = true, pro_archived_at = NOW(), pro_archived_by = $2, pro_updated_at = NOW()
        WHERE pro_id = $1 AND pro_is_archived = false
        RETURNING pro_id`,
      [id, req.user.user_id]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Project not found' });
    }
    await audit(client, req.user.user_id, 'ARCHIVE', id, {});
    await client.query('COMMIT');
    res.json({ success: true, message: 'Project archived' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, error, 'Archive Project');
  } finally {
    client.release();
  }
};

// Admin only: bring an archived project back
const restoreProject = async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid project id' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE projects
          SET pro_is_archived = false, pro_archived_at = NULL, pro_archived_by = NULL, pro_updated_at = NOW()
        WHERE pro_id = $1 AND pro_is_archived = true
        RETURNING pro_id`,
      [id]
    );
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Archived project not found' });
    }
    await audit(client, req.user.user_id, 'RESTORE', id, {});
    await client.query('COMMIT');
    res.json({ success: true, message: 'Project restored' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    handleError(res, error, 'Restore Project');
  } finally {
    client.release();
  }
};

module.exports = {
  listProjects, getProject, listArchived, listCoordinators, listManagers,
  createProject, updateProject, archiveProject, restoreProject
};