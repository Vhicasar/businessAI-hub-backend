-- Links an invitation back to the employee record it was raised from, so that
-- accepting it can populate Employee.userId (which is what makes an employee
-- assignable as a lead owner, approver, etc).
ALTER TABLE "Invitation" ADD COLUMN "employeeId" TEXT;

CREATE INDEX "Invitation_employeeId_idx" ON "Invitation"("employeeId");

ALTER TABLE "Invitation"
  ADD CONSTRAINT "Invitation_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
