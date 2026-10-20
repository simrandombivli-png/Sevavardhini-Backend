const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/taskController');

router.use(authenticateToken);

// Must stay ABOVE '/:id'.
router.get('/project/:projectId/coordinators', authorizeRoles('Admin', 'Project_Manager'), c.listAssignees);

router.get('/', c.listTasks);                 // each role sees only its own scope
router.get('/:id', c.getTask);
router.post('/', authorizeRoles('Admin', 'Project_Manager'), c.createTask);
router.patch('/:id', authorizeRoles('Admin', 'Project_Manager'), c.updateTask);
router.patch('/:id/status', c.updateStatus);  // for coordinators, the controller checks the task is theirs
router.delete('/:id', authorizeRoles('Admin', 'Project_Manager'), c.deleteTask);

module.exports = router;
