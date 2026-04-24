-- ============================================
-- Seed default admin user
-- Email:    info@dagborn.se
-- Password: Norraberget20  (bcrypt cost 10, change with /api/auth/* endpoint after first login)
-- Idempotent: re-running updates the password to the bcrypt hash below.
-- ============================================

INSERT INTO users (name, email, password_hash, role)
VALUES (
  'Dagborn',
  'info@dagborn.se',
  '$2b$10$rNm1uoxTlHRZxhIodX.C6.iPLmBaJ3o9v8mDTb7FaGA.ViBIXBkem',
  'admin'
)
ON CONFLICT (email) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      name = EXCLUDED.name,
      role = EXCLUDED.role;
