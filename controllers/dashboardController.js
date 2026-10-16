const db = require('../config/db');

const getDashboardData = async (req, res) => {
  const { user_id, role } = req.user;

  try {
    let dashboardData = {};

    if (role === 'Admin') {
      // Admin sees overall metrics. Archived projects are counted separately,
      // and their tasks are left out of the task total.
      const { rows } = await db.query(
        `SELECT
           (SELECT COUNT(*) FROM users WHERE user_is_active = true)        AS total_users,
           (SELECT COUNT(*) FROM projects WHERE pro_is_archived = false)   AS total_projects,
           (SELECT COUNT(*) FROM projects WHERE pro_is_archived = true)    AS archived_projects,
           (SELECT COUNT(*) FROM tasks t
              JOIN projects p ON p.pro_id = t.project_id
             WHERE p.pro_is_archived = false)                              AS total_tasks`
      );

      dashboardData = {
        role: 'Admin',
        stats: {
          totalUsers: Number(rows[0].total_users),
          totalProjects: Number(rows[0].total_projects),
          totalArchivedProjects: Number(rows[0].archived_projects),
          totalTasks: Number(rows[0].total_tasks)
        }
      };
    } else if (role === 'Project_Manager') {
      // Manager sees only their own, non-archived projects and the tasks in them
      const projects = await db.query(
        `SELECT pro_id, pro_title, pro_domain, pro_status
           FROM projects
          WHERE pro_managed_by = $1 AND pro_is_archived = false`,
        [user_id]
      );

      const tasksCount = await db.query(
        `SELECT COUNT(t.task_id)
           FROM tasks t
           JOIN projects p ON t.project_id = p.pro_id
          WHERE p.pro_managed_by = $1 AND p.pro_is_archived = false`,
        [user_id]
      );

      dashboardData = {
        role: 'Project_Manager',
        managedProjects: projects.rows,
        stats: {
          totalManagedProjects: projects.rows.length,
          totalProjectTasks: Number(tasksCount.rows[0].count)
        }
      };
    } else {
      // Coordinator sees tasks assigned to them, from non-archived projects only
      const assignedTasks = await db.query(
        `SELECT t.task_id, t.task_title, t.task_status, t.task_priority, t.deadline, p.pro_title
           FROM tasks t
           JOIN projects p ON t.project_id = p.pro_id
          WHERE t.task_assigned_to = $1 AND p.pro_is_archived = false`,
        [user_id]
      );

      dashboardData = {
        role: 'Coordinator',
        assignedTasks: assignedTasks.rows,
        stats: {
          totalAssignedTasks: assignedTasks.rows.length
        }
      };
    }

    res.status(200).json({
      success: true,
      data: dashboardData
    });
  } catch (error) {
    console.error('Dashboard Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = { getDashboardData };