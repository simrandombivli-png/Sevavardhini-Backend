const db = require('../config/db');

// Keep these lists in sync with the CHECK constraints on the tasks table.
const STATUSES = ['Pending', 'In_Progress', 'Completed'];
const PRIORITIES = ['Low', 'Medium', 'High'];

// ---------- validation ----------
const parseId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

const isoDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// Checks the fields of a task. partial = true for PATCH (only checks what was sent).
const parseTask = (b = {}, partial) => {
  const errors = [];
  const data = {};
  const has = (k) => b[k] !== undefined;

  if (has('project_id') && partial) errors.push('A task cannot be moved to another project');

  if (!partial || has('task_title')) {
    const v = typeof b.task_title === 'string' ? b.task_title.trim() : '';
    if (!v || v.length > 200) errors.push('task_title is required (max 200 characters)');
    data.task_title = v;
  }
  if (has('task_description')) {
    if (b.task_description !== null && typeof b.task_description !== 'string') {
      errors.push('task_description must be text');
    } else {
      data.task_description = b.task_description === null ? null : b.task_description.trim();
    }
  }
  if (has('task_assigned_to')) {
    if (b.task_assigned_to === null) data.task_assigned_to = null;
    else {
      const n = parseId(b.task_assigned_to);
      if (!n) errors.push('task_assigned_to must be a user id or null');
      else data.task_assigned_to = n;
    }
  }
  if (has('task_status')) {
    if (!STATUSES.includes(b.task_status)) errors.push(`task_status must be one of: ${STATUSES.join(', ')}`);
    data.task_status = b.task_status;
  }
  if (has('task_priority')) {
    if (!PRIORITIES.includes(b.task_priority)) errors.push(`task_priority must be one of: ${PRIORITIES.join(', ')}`);
    data.task_priority = b.task_priority;
  }
  if (has('deadline')) {
    if (b.deadline !== null && !isoDate(b.deadline)) errors.push('deadline must be a valid date in YYYY-MM-DD format');
    data.deadline = b.deadline;
  }
  return { errors, data };
};

// ---------- helpers ----------
const TASK_SELECT = `
  SELECT t.task_id, t.project_id, p.pro_title, t.task_title, t.task_description,
         t.task_assigned_to, u.user_name AS assigned_to_name,
         t.task_status, t.task_priority, t.deadline::text AS deadline,
         t.task_created_at, t.task_updated_at
    FROM tasks t
    JOIN projects p ON p.pro_id = t.project_id
    LEFT JOIN users u ON u.user_id = t.task_assigned_to`;


// Admin: everything. Project Manager: tasks of their own, non-archived projects.
// Coordinator: only tasks assigned to them, in non-archived projects.
const visibility = (user, startAt) => {
  if (user.role === 'Admin') return { sql: 'TRUE', params: [] };
  if (user.role === 'Project_Manager') {
    return { sql: `p.pro_managed_by = $${startAt} AND p.pro_is_archived = false`, params: [user.user_id] };
  }
  return { sql: `t.task_assigned_to = $${startAt} AND p.pro_is_archived = false`, params: [user.user_id] };
};

const audit = (client, userId, action, taskId, details) =>
  client.query(
    `INSERT INTO audit_logs (log_user_id, log_action, log_entity_type, log_entity_id, log_details)
     VALUES ($1, $2, 'task', $3, $4)`,
    [userId, action, taskId, JSON.stringify(details || {})]
  );

const withTransaction = async (fn) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
};

// Used to stop a handler part-way: throw it, the catch block sends the response.
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const handleError = (res, error, label) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  if (error.code === '23514') {
    return res.status(400).json({ success: false, message: 'One of the values is not allowed' });
  }
  if (error.code === '23503') {
    return res.status(400).json({ success: false, message: 'A referenced project or user does not exist' });
  }
  if (error.code === '22P02') {
    return res.status(400).json({ success: false, message: 'Invalid value' });
  }
  console.error(label, error);
  return res.status(500).json({ success: false, message: 'Internal server error' });
};

// The assignee must be an active Coordinator that is assigned to this project.
const checkAssignee = async (client, projectId, userId) => {
  const { rows } = await client.query(
    `SELECT 1
       FROM users u
       JOIN project_coordinators pc ON pc.coord_user_id = u.user_id AND pc.coord_project_id = $1
      WHERE u.user_id = $2 AND u.role = 'Coordinator' AND u.user_is_active = true`,
    [projectId, userId]
  );
  if (!rows[0]) throw new HttpError(400, 'task_assigned_to must be an active coordinator of this project');
};

// Loads a task + its project and locks the task row. Throws 404 if the user may not see it.
const loadForChange = async (client, taskId, user) => {
  const { rows } = await client.query(
    `SELECT t.task_id, t.project_id, t.task_assigned_to, t.task_status,
            p.pro_managed_by, p.pro_is_archived
       FROM tasks t JOIN projects p ON p.pro_id = t.project_id
      WHERE t.task_id = $1
        FOR UPDATE OF t`,
    [taskId]
  );
  const task = rows[0];
  if (!task) throw new HttpError(404, 'Task not found');
  if (user.role === 'Project_Manager' && task.pro_managed_by !== user.user_id) {
    throw new HttpError(404, 'Task not found');
  }
  if (user.role === 'Coordinator' && task.task_assigned_to !== user.user_id) {
    throw new HttpError(404, 'Task not found');
  }
  if (task.pro_is_archived) throw new HttpError(409, 'This project is archived. Restore it before changing its tasks');
  return task;
};

// Builds "col = $n" pairs for a dynamic UPDATE.
const buildSet = (data, startAt = 1) => {
  const cols = Object.keys(data);
  return {
    sql: cols.map((c, i) => `${c} = $${startAt + i}`).join(', '),
    params: cols.map((c) => data[c]),
    next: startAt + cols.length,
  };
};

const fetchOne = async (client, taskId) => {
  const { rows } = await client.query(`${TASK_SELECT} WHERE t.task_id = $1`, [taskId]);
  return rows[0];
};

// ---------- handlers ----------

// GET /api/tasks?project_id=&status=&priority=&assigned_to=&q=
const listTasks = async (req, res) => {
  try {
    const vis = visibility(req.user, 1);
    const where = [vis.sql];
    const params = [...vis.params];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

    if (req.query.project_id !== undefined) {
      const id = parseId(req.query.project_id);
      if (!id) return res.status(400).json({ success: false, message: 'project_id must be a number' });
      add('t.project_id = ?', id);
    }
    if (req.query.status !== undefined) {
      if (!STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${STATUSES.join(', ')}` });
      }
      add('t.task_status = ?', req.query.status);
    }
    if (req.query.priority !== undefined) {
      if (!PRIORITIES.includes(req.query.priority)) {
        return res.status(400).json({ success: false, message: `priority must be one of: ${PRIORITIES.join(', ')}` });
      }
      add('t.task_priority = ?', req.query.priority);
    }
    if (req.query.assigned_to !== undefined) {
      const id = parseId(req.query.assigned_to);
      if (!id) return res.status(400).json({ success: false, message: 'assigned_to must be a number' });
      add('t.task_assigned_to = ?', id);
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const escaped = req.query.q.trim().slice(0, 100).replace(/[\\%_]/g, '\\$&');
      add('t.task_title ILIKE ?', `%${escaped}%`);
    }

    const { rows } = await db.query(
      `${TASK_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY t.deadline ASC NULLS LAST, t.task_id DESC LIMIT 500`,
      params
    );
    res.status(200).json({ success: true, count: rows.length, tasks: rows });
  } catch (error) {
    handleError(res, error, 'List Tasks Error:');
  }
};

// GET /api/tasks/:id
const getTask = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid task id' });
    const vis = visibility(req.user, 2);
    const { rows } = await db.query(`${TASK_SELECT} WHERE t.task_id = $1 AND ${vis.sql}`, [id, ...vis.params]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Task not found' });
    res.status(200).json({ success: true, task: rows[0] });
  } catch (error) {
    handleError(res, error, 'Get Task Error:');
  }
};

// POST /api/tasks   (Admin, Project_Manager of that project)
const createTask = async (req, res) => {
  try {
    const projectId = parseId(req.body?.project_id);
    if (!projectId) return res.status(400).json({ success: false, message: 'project_id is required' });
    const { errors, data } = parseTask(req.body, false);
    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });

    const task = await withTransaction(async (client) => {
      const proj = await client.query(
        'SELECT pro_managed_by, pro_is_archived FROM projects WHERE pro_id = $1', [projectId]);
      const p = proj.rows[0];
      if (!p || (req.user.role === 'Project_Manager' && p.pro_managed_by !== req.user.user_id)) {
        throw new HttpError(404, 'Project not found');
      }
      if (p.pro_is_archived) throw new HttpError(409, 'This project is archived. Restore it before adding tasks');
      if (data.task_assigned_to) await checkAssignee(client, projectId, data.task_assigned_to);

      const row = { project_id: projectId, ...data };
      const cols = Object.keys(row);
      const ins = await client.query(
        `INSERT INTO tasks (${cols.join(', ')})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING task_id`,
        cols.map((c) => row[c])
      );
      const taskId = ins.rows[0].task_id;
      await audit(client, req.user.user_id, 'CREATE', taskId, { project_id: projectId, task_title: data.task_title });
      return fetchOne(client, taskId);
    });

    res.status(201).json({ success: true, message: 'Task created', task });
  } catch (error) {
    handleError(res, error, 'Create Task Error:');
  }
};

// PATCH /api/tasks/:id   (Admin, Project_Manager of that project)
const updateTask = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid task id' });
    const { errors, data } = parseTask(req.body, true);
    if (errors.length) return res.status(400).json({ success: false, message: 'Validation failed', errors });
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    const task = await withTransaction(async (client) => {
      const current = await loadForChange(client, id, req.user);
      if (data.task_assigned_to) await checkAssignee(client, current.project_id, data.task_assigned_to);

      const set = buildSet({ ...data, task_updated_at: new Date() });
      await client.query(`UPDATE tasks SET ${set.sql} WHERE task_id = $${set.next}`, [...set.params, id]);
      await audit(client, req.user.user_id, 'UPDATE', id, { changed: Object.keys(data) });
      return fetchOne(client, id);
    });

    res.status(200).json({ success: true, message: 'Task updated', task });
  } catch (error) {
    handleError(res, error, 'Update Task Error:');
  }
};

// PATCH /api/tasks/:id/status   (Admin, Project_Manager of that project, Coordinator it is assigned to)
const updateStatus = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid task id' });
    const status = req.body?.task_status;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `task_status must be one of: ${STATUSES.join(', ')}` });
    }

    const task = await withTransaction(async (client) => {
      const current = await loadForChange(client, id, req.user);
      await client.query(
        'UPDATE tasks SET task_status = $1, task_updated_at = NOW() WHERE task_id = $2', [status, id]);
      await audit(client, req.user.user_id, 'STATUS', id, { from: current.task_status, to: status });
      return fetchOne(client, id);
    });

    res.status(200).json({ success: true, message: 'Status updated', task });
  } catch (error) {
    handleError(res, error, 'Update Status Error:');
  }
};

// DELETE /api/tasks/:id   (Admin, Project_Manager of that project)
// Tasks have no archive column, so this removes the row. The audit log keeps a record of it.
const deleteTask = async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid task id' });

    await withTransaction(async (client) => {
      await loadForChange(client, id, req.user);
      const before = await fetchOne(client, id);
      await client.query('DELETE FROM tasks WHERE task_id = $1', [id]);
      await audit(client, req.user.user_id, 'DELETE', id, {
        project_id: before.project_id, task_title: before.task_title, task_status: before.task_status,
      });
    });

    res.status(200).json({ success: true, message: 'Task deleted' });
  } catch (error) {
    handleError(res, error, 'Delete Task Error:');
  }
};

// GET /api/tasks/project/:projectId/coordinators  -> coordinators you can assign (for the dropdown)
const listAssignees = async (req, res) => {
  try {
    const projectId = parseId(req.params.projectId);
    if (!projectId) return res.status(400).json({ success: false, message: 'Invalid project id' });
    const { rows } = await db.query(
      `SELECT u.user_id, u.user_name
         FROM project_coordinators pc
         JOIN users u ON u.user_id = pc.coord_user_id AND u.user_is_active = true AND u.role = 'Coordinator'
         JOIN projects p ON p.pro_id = pc.coord_project_id
        WHERE pc.coord_project_id = $1
          AND ($2 = 'Admin' OR p.pro_managed_by = $3)
        ORDER BY u.user_name`,
      [projectId, req.user.role, req.user.user_id]
    );
    res.status(200).json({ success: true, coordinators: rows });
  } catch (error) {
    handleError(res, error, 'List Assignees Error:');
  }
};

module.exports = { listTasks, getTask, createTask, updateTask, updateStatus, deleteTask, listAssignees };
