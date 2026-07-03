-- ============================================
-- Seed the initial admin user
--
-- SECURITY: this file contains NO password and NO password hash. You must
-- generate a bcrypt hash for a strong, unique password at run time and pass
-- it in as a psql variable. Never commit a real hash or password.
--
--   1) Generate a bcrypt hash (cost 10) for your chosen password:
--        node -e "console.log(require('bcryptjs').hashSync(process.argv[1],10))" 'DIN_STARKA_LOSEN'
--
--   2) Run this seed, passing email + hash as variables:
--        psql "$DATABASE_URL" \
--          -v admin_email='du@example.com' \
--          -v admin_hash='<hash-fran-steg-1>' \
--          -f database/seed-admin.sql
--
-- Re-running is safe: ON CONFLICT DO NOTHING means an existing admin's
-- password is NEVER overwritten, so a rotated password can't be silently
-- reverted by a redeploy. To rotate, change it via the app, not by re-seeding.
-- ============================================

INSERT INTO users (name, email, password_hash, role)
VALUES (
  'Admin',
  lower(:'admin_email'),
  :'admin_hash',
  'admin'
)
ON CONFLICT (email) DO NOTHING;
