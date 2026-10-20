const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/projectController');

router.use(authenticateToken);

// Admin-only lookups. These must stay ABOVE '/:id', or Express reads "archived" as an id.
router.get('/coordinators', authorizeRoles('Admin'), c.listCoordinators);
router.get('/managers', authorizeRoles('Admin'), c.listManagers);
router.get('/archived', authorizeRoles('Admin'), c.listArchived);

router.get('/', c.listProjects);                       // each role sees only its own scope
router.get('/:id', c.getProject);
router.post('/', authorizeRoles('Admin'), c.createProject);
router.patch('/:id', authorizeRoles('Admin', 'Project_Manager'), c.updateProject);
router.delete('/:id', authorizeRoles('Admin'), c.archiveProject);   // archives, never really deletes
router.post('/:id/restore', authorizeRoles('Admin'), c.restoreProject);

module.exports = router;