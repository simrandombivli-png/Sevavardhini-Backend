const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middleware/authMiddleware');
const c = require('../controllers/projectController');

router.use(authenticateToken);

router.get('/coordinators', authorizeRoles('Project_Manager'), c.listCoordinators); // must stay above '/:id'
router.get('/', c.listProjects);
router.get('/:id', c.getProject);
router.post('/', authorizeRoles('Project_Manager'), c.createProject);
router.patch('/:id', authorizeRoles('Project_Manager'), c.updateProject);
router.delete('/:id', authorizeRoles('Project_Manager'), c.archiveProject);

module.exports = router;