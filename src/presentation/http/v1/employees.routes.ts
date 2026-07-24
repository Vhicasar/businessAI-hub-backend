import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  createEmployeeSchema,
  departmentSchema,
  employeesService,
  listEmployeesSchema,
  updateEmployeeSchema,
} from '../../../application/employees/employees.service';
import {
  createLeaveRequestSchema,
  decideLeaveSchema,
  leaveService,
  leaveTypeSchema,
  listLeaveSchema,
} from '../../../application/employees/leave.service';
import {
  assignShiftSchema,
  attendanceService,
  clockSchema,
  listAttendanceSchema,
  shiftSchema,
} from '../../../application/employees/attendance.service';
import {
  assignComponentSchema,
  createRunSchema,
  payComponentSchema,
  payrollConfigSchema,
  payrollService,
} from '../../../application/employees/payroll.service';
import {
  assetSchema,
  assetsService,
  assignAssetSchema,
  decideExpenseSchema,
  expenseSchema,
  listAssetsSchema,
  listExpensesSchema,
  returnAssetSchema,
} from '../../../application/employees/assets.service';
import {
  applicantSchema,
  checklistsSchema,
  hireSchema,
  interviewFeedbackSchema,
  interviewSchema,
  jobPostingSchema,
  listApplicantsSchema,
  moveStageSchema,
  recruitmentService,
} from '../../../application/employees/recruitment.service';
import {
  employeeInvitesService,
  inviteEmployeesSchema,
} from '../../../application/employees/invites.service';
import { employeeProfileService } from '../../../application/employees/profile.service';
import {
  courseSchema,
  cycleSchema,
  enrollSchema,
  feedbackSchema,
  goalSchema,
  performanceService,
  progressSchema,
  reviewSchema,
  updateGoalSchema,
} from '../../../application/employees/performance.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const employeesRoutes = Router();
employeesRoutes.use(authenticate, requireTenant);

employeesRoutes.get(
  '/',
  requirePermission('employees.read'),
  validate({ query: listEmployeesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeesService.list(req.query as never) });
  })
);

employeesRoutes.get(
  '/departments',
  requirePermission('employees.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await employeesService.listDepartments() });
  })
);
employeesRoutes.post(
  '/departments',
  requirePermission('employees.manage_departments', 'settings.manage_org'),
  validate({ body: departmentSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await employeesService.createDepartment(req.body) });
  })
);
employeesRoutes.patch(
  '/departments/:id',
  requirePermission('employees.manage_departments', 'settings.manage_org'),
  validate({ body: departmentSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeesService.updateDepartment(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/departments/:id',
  requirePermission('employees.manage_departments', 'settings.manage_org'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeesService.deleteDepartment(req.params.id as string) });
  })
);

employeesRoutes.post(
  '/',
  requirePermission('employees.create'),
  validate({ body: createEmployeeSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await employeesService.create(req.body) });
  })
);

// ------------------------------------------------------------- leave types
// Registered before '/:id' so these paths are never swallowed by the param route.
employeesRoutes.get(
  '/leave/types',
  requirePermission('leave.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await leaveService.listTypes() });
  })
);
employeesRoutes.post(
  '/leave/types',
  requirePermission('leave.manage_types'),
  validate({ body: leaveTypeSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await leaveService.createType(req.body) });
  })
);
employeesRoutes.patch(
  '/leave/types/:id',
  requirePermission('leave.manage_types'),
  validate({ body: leaveTypeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await leaveService.updateType(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/leave/types/:id',
  requirePermission('leave.manage_types'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await leaveService.deleteType(req.params.id as string) });
  })
);

// ---------------------------------------------------------- leave requests
employeesRoutes.get(
  '/leave/requests',
  requirePermission('leave.read'),
  validate({ query: listLeaveSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await leaveService.list(req.query as never) });
  })
);
employeesRoutes.post(
  '/leave/requests',
  requirePermission('leave.request'),
  validate({ body: createLeaveRequestSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await leaveService.create(req.body) });
  })
);
employeesRoutes.post(
  '/leave/requests/:id/decide',
  requirePermission('leave.approve'),
  validate({ body: decideLeaveSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await leaveService.decide(req.params.id as string, req.body) });
  })
);
employeesRoutes.post(
  '/leave/requests/:id/cancel',
  requirePermission('leave.request', 'leave.approve'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await leaveService.cancel(req.params.id as string) });
  })
);

// ------------------------------------------------------------------ shifts
employeesRoutes.get(
  '/shifts',
  requirePermission('attendance.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await attendanceService.listShifts() });
  })
);
employeesRoutes.post(
  '/shifts',
  requirePermission('attendance.manage_shifts'),
  validate({ body: shiftSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await attendanceService.createShift(req.body) });
  })
);
employeesRoutes.patch(
  '/shifts/:id',
  requirePermission('attendance.manage_shifts'),
  validate({ body: shiftSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await attendanceService.updateShift(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/shifts/:id',
  requirePermission('attendance.manage_shifts'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await attendanceService.deleteShift(req.params.id as string) });
  })
);

// ------------------------------------------------------------------ roster
employeesRoutes.get(
  '/roster',
  requirePermission('attendance.read'),
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 7 * 86_400_000);
    res.json({ success: true, data: await attendanceService.listRoster(from, to) });
  })
);
employeesRoutes.post(
  '/roster',
  requirePermission('attendance.manage_roster'),
  validate({ body: assignShiftSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await attendanceService.assignShift(req.body) });
  })
);
employeesRoutes.delete(
  '/roster/:id',
  requirePermission('attendance.manage_roster'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await attendanceService.unassignShift(req.params.id as string) });
  })
);

// -------------------------------------------------------------- attendance
employeesRoutes.get(
  '/attendance',
  requirePermission('attendance.read'),
  validate({ query: listAttendanceSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await attendanceService.list(req.query as never) });
  })
);
employeesRoutes.get(
  '/attendance/summary',
  requirePermission('attendance.read'),
  wrap(async (req, res) => {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 86_400_000);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    res.json({ success: true, data: await attendanceService.summary(from, to) });
  })
);
employeesRoutes.get(
  '/attendance/today/:employeeId',
  requirePermission('attendance.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await attendanceService.today(req.params.employeeId as string) });
  })
);
employeesRoutes.post(
  '/attendance/clock-in',
  requirePermission('attendance.clock'),
  validate({ body: clockSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await attendanceService.clockIn(req.body) });
  })
);
employeesRoutes.post(
  '/attendance/clock-out',
  requirePermission('attendance.clock'),
  validate({ body: clockSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await attendanceService.clockOut(req.body) });
  })
);

// ----------------------------------------------------------------- payroll
employeesRoutes.get(
  '/payroll/config',
  requirePermission('payroll.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await payrollService.getConfig() });
  })
);
employeesRoutes.put(
  '/payroll/config',
  requirePermission('payroll.configure'),
  validate({ body: payrollConfigSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.saveConfig(req.body) });
  })
);

employeesRoutes.get(
  '/payroll/components',
  requirePermission('payroll.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await payrollService.listComponents() });
  })
);
employeesRoutes.post(
  '/payroll/components',
  requirePermission('payroll.configure'),
  validate({ body: payComponentSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await payrollService.createComponent(req.body) });
  })
);
employeesRoutes.patch(
  '/payroll/components/:id',
  requirePermission('payroll.configure'),
  validate({ body: payComponentSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.updateComponent(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/payroll/components/:id',
  requirePermission('payroll.configure'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.deleteComponent(req.params.id as string) });
  })
);

employeesRoutes.post(
  '/payroll/components/assign',
  requirePermission('payroll.configure'),
  validate({ body: assignComponentSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await payrollService.assignComponent(req.body) });
  })
);
employeesRoutes.delete(
  '/payroll/components/assign/:id',
  requirePermission('payroll.configure'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.unassignComponent(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/payroll/runs',
  requirePermission('payroll.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await payrollService.listRuns() });
  })
);
employeesRoutes.post(
  '/payroll/runs',
  requirePermission('payroll.process'),
  validate({ body: createRunSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await payrollService.createRun(req.body) });
  })
);
employeesRoutes.get(
  '/payroll/runs/:id',
  requirePermission('payroll.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.getRun(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/payroll/runs/:id/approve',
  requirePermission('payroll.approve'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.approveRun(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/payroll/runs/:id/pay',
  requirePermission('payroll.pay'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.markPaid(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/payroll/runs/:id/cancel',
  requirePermission('payroll.process'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.cancelRun(req.params.id as string) });
  })
);

// ------------------------------------------------------------------ assets
employeesRoutes.get(
  '/assets',
  requirePermission('assets.read'),
  validate({ query: listAssetsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.listAssets(req.query as never) });
  })
);
employeesRoutes.post(
  '/assets',
  requirePermission('assets.create'),
  validate({ body: assetSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await assetsService.createAsset(req.body) });
  })
);
employeesRoutes.get(
  '/assets/:id',
  requirePermission('assets.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.assetHistory(req.params.id as string) });
  })
);
employeesRoutes.patch(
  '/assets/:id',
  requirePermission('assets.update'),
  validate({ body: assetSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.updateAsset(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/assets/:id',
  requirePermission('assets.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.deleteAsset(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/assets/:id/assign',
  requirePermission('assets.assign'),
  validate({ body: assignAssetSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await assetsService.assignAsset(req.params.id as string, req.body) });
  })
);
employeesRoutes.post(
  '/assets/:id/return',
  requirePermission('assets.assign'),
  validate({ body: returnAssetSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.returnAsset(req.params.id as string, req.body) });
  })
);

// ---------------------------------------------------------------- expenses
employeesRoutes.get(
  '/expenses',
  requirePermission('expenses.read'),
  validate({ query: listExpensesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.listExpenses(req.query as never) });
  })
);
employeesRoutes.post(
  '/expenses',
  requirePermission('expenses.create'),
  validate({ body: expenseSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await assetsService.createExpense(req.body) });
  })
);
employeesRoutes.post(
  '/expenses/:id/decide',
  requirePermission('expenses.approve'),
  validate({ body: decideExpenseSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.decideExpense(req.params.id as string, req.body) });
  })
);
employeesRoutes.post(
  '/expenses/:id/reimburse',
  requirePermission('expenses.reimburse'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await assetsService.reimburseExpense(req.params.id as string) });
  })
);

// ------------------------------------------------------------- recruitment
employeesRoutes.get(
  '/recruitment/checklists',
  requirePermission('recruitment.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await recruitmentService.getChecklists() });
  })
);
employeesRoutes.put(
  '/recruitment/checklists',
  requirePermission('recruitment.update'),
  validate({ body: checklistsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.saveChecklists(req.body) });
  })
);

employeesRoutes.get(
  '/recruitment/jobs',
  requirePermission('recruitment.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await recruitmentService.listJobs() });
  })
);
employeesRoutes.post(
  '/recruitment/jobs',
  requirePermission('recruitment.create'),
  validate({ body: jobPostingSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await recruitmentService.createJob(req.body) });
  })
);
employeesRoutes.patch(
  '/recruitment/jobs/:id',
  requirePermission('recruitment.update'),
  validate({ body: jobPostingSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.updateJob(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/recruitment/jobs/:id',
  requirePermission('recruitment.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.deleteJob(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/recruitment/applicants',
  requirePermission('recruitment.read'),
  validate({ query: listApplicantsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.listApplicants(req.query as never) });
  })
);
employeesRoutes.post(
  '/recruitment/applicants',
  requirePermission('recruitment.create'),
  validate({ body: applicantSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await recruitmentService.createApplicant(req.body) });
  })
);
employeesRoutes.get(
  '/recruitment/applicants/:id',
  requirePermission('recruitment.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.getApplicant(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/recruitment/applicants/:id/stage',
  requirePermission('recruitment.update'),
  validate({ body: moveStageSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.moveStage(req.params.id as string, req.body.stage) });
  })
);
employeesRoutes.post(
  '/recruitment/applicants/:id/hire',
  requirePermission('recruitment.hire'),
  validate({ body: hireSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await recruitmentService.hire(req.params.id as string, req.body) });
  })
);

employeesRoutes.get(
  '/recruitment/interviews',
  requirePermission('recruitment.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await recruitmentService.upcomingInterviews() });
  })
);
employeesRoutes.post(
  '/recruitment/interviews',
  requirePermission('recruitment.update'),
  validate({ body: interviewSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await recruitmentService.scheduleInterview(req.body) });
  })
);
employeesRoutes.post(
  '/recruitment/interviews/:id/feedback',
  requirePermission('recruitment.update'),
  validate({ body: interviewFeedbackSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.recordFeedback(req.params.id as string, req.body) });
  })
);

// ------------------------------------------------------------ performance
employeesRoutes.get(
  '/performance/cycles',
  requirePermission('performance.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await performanceService.listCycles() });
  })
);
employeesRoutes.post(
  '/performance/cycles',
  requirePermission('performance.manage_cycles'),
  validate({ body: cycleSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await performanceService.createCycle(req.body) });
  })
);
employeesRoutes.post(
  '/performance/cycles/:id/activate',
  requirePermission('performance.manage_cycles'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.activateCycle(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/performance/cycles/:id/close',
  requirePermission('performance.manage_cycles'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.closeCycle(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/performance/reviews',
  requirePermission('performance.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await performanceService.listReviews(req.query.cycleId as string | undefined, req.query.employeeId as string | undefined),
    });
  })
);
employeesRoutes.post(
  '/performance/reviews/:id/submit',
  requirePermission('performance.review'),
  validate({ body: reviewSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.submitReview(req.params.id as string, req.body) });
  })
);
employeesRoutes.post(
  '/performance/reviews/:id/acknowledge',
  requirePermission('performance.review'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.acknowledgeReview(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/performance/goals',
  requirePermission('performance.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await performanceService.listGoals(req.query.employeeId as string | undefined, req.query.cycleId as string | undefined),
    });
  })
);
employeesRoutes.post(
  '/performance/goals',
  requirePermission('performance.manage_goals'),
  validate({ body: goalSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await performanceService.createGoal(req.body) });
  })
);
employeesRoutes.patch(
  '/performance/goals/:id',
  requirePermission('performance.manage_goals'),
  validate({ body: updateGoalSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.updateGoal(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/performance/goals/:id',
  requirePermission('performance.manage_goals'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.deleteGoal(req.params.id as string) });
  })
);

employeesRoutes.post(
  '/performance/feedback',
  requirePermission('performance.give_feedback'),
  validate({ body: feedbackSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await performanceService.giveFeedback(req.body) });
  })
);

// --------------------------------------------------------------- learning
employeesRoutes.get(
  '/learning/courses',
  requirePermission('learning.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await performanceService.listCourses() });
  })
);
employeesRoutes.post(
  '/learning/courses',
  requirePermission('learning.manage_courses'),
  validate({ body: courseSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await performanceService.createCourse(req.body) });
  })
);
employeesRoutes.patch(
  '/learning/courses/:id',
  requirePermission('learning.manage_courses'),
  validate({ body: courseSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.updateCourse(req.params.id as string, req.body) });
  })
);
employeesRoutes.delete(
  '/learning/courses/:id',
  requirePermission('learning.manage_courses'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.deleteCourse(req.params.id as string) });
  })
);
employeesRoutes.post(
  '/learning/courses/:id/enroll-all',
  requirePermission('learning.enroll'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.enrollAll(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/learning/enrollments',
  requirePermission('learning.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await performanceService.listEnrollments(req.query.employeeId as string | undefined, req.query.status as string | undefined),
    });
  })
);
employeesRoutes.post(
  '/learning/enrollments',
  requirePermission('learning.enroll'),
  validate({ body: enrollSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await performanceService.enroll(req.body) });
  })
);
employeesRoutes.patch(
  '/learning/enrollments/:id/progress',
  requirePermission('learning.enroll'),
  validate({ body: progressSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.setProgress(req.params.id as string, req.body) });
  })
);

// ---------------------------------------------------------------- invites
// Declared before '/:id' so these paths aren't swallowed by the param route.
// Inviting creates logins, so it needs the user-management permission as well
// as employee access — being able to edit a staff record is not the same as
// being able to hand someone the keys.
const canInvite = requirePermission('employees.invite', 'settings.manage_users');

employeesRoutes.get(
  '/invites/preview/department/:id',
  canInvite,
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeeInvitesService.previewDepartment(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/invites/preview/employee/:id',
  canInvite,
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeeInvitesService.previewEmployee(req.params.id as string) });
  })
);

employeesRoutes.post(
  '/invites/department/:id',
  canInvite,
  validate({ body: inviteEmployeesSchema }),
  wrap(async (req, res) => {
    const data = await employeeInvitesService.inviteDepartment(req.params.id as string, req.body.roleId);
    res.status(201).json({ success: true, data });
  })
);

employeesRoutes.post(
  '/invites/employee/:id',
  canInvite,
  validate({ body: inviteEmployeesSchema }),
  wrap(async (req, res) => {
    const data = await employeeInvitesService.inviteEmployee(req.params.id as string, req.body.roleId);
    res.status(201).json({ success: true, data });
  })
);

// The profile aggregates several modules; each section inside is gated by its
// own permission, so employees.read is the right floor for the page itself.
employeesRoutes.get(
  '/:id/profile',
  requirePermission('employees.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeeProfileService.get(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/:id/feedback',
  requirePermission('performance.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await performanceService.listFeedback(req.params.id as string) });
  })
);

employeesRoutes.post(
  '/:id/offboard',
  requirePermission('employees.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await recruitmentService.offboard(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/:id/pay-components',
  requirePermission('payroll.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await payrollService.employeeComponents(req.params.id as string) });
  })
);

employeesRoutes.get(
  '/:id/leave-balances',
  requirePermission('leave.read'),
  wrap(async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json({ success: true, data: await leaveService.balances(req.params.id as string, year) });
  })
);

employeesRoutes.get(
  '/:id',
  requirePermission('employees.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeesService.get(req.params.id as string) });
  })
);

employeesRoutes.patch(
  '/:id',
  requirePermission('employees.update'),
  validate({ body: updateEmployeeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeesService.update(req.params.id as string, req.body) });
  })
);

employeesRoutes.delete(
  '/:id',
  requirePermission('employees.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await employeesService.remove(req.params.id as string) });
  })
);
