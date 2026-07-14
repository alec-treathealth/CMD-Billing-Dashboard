-- 0051 ROLLBACK: remove exactly the seeded alias rows (delete-by-alias_text; any
-- operator-added rows with other alias_texts survive). Idempotent; safe to re-run.
set role claims_admin;
delete from claims.payer_alias
 where business_entity_id = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088'
   and alias_text in (
    'Anthem BCBS CALIFORNIA', 'Anthem of CALIFORNIA', 'BCBS IL (Blue Card)',
    'BCBS TX (Blue Card)', 'GEHA', 'Cigna', 'UMR', 'Blue Cards', 'Optum/UHC/UMR',
    'Anthem BCBS', 'All other BCBS (Including Anthem)'
   );
reset role;
