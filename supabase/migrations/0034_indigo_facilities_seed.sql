-- 0034: seed Indigo Billing's facilities into collections.facilities.
--
-- WHY: the Master Chart, tables, and IP/OP dimension resolve a bar's display name by
-- LEFT JOIN collections.facilities ON facility_code (src/collections/summary.ts,
-- daily.ts). Indigo's facility_code is the raw CMD customer id (e.g. '10028595'), which
-- was NEVER in this dimension — so every Indigo facility rendered as "(unassigned)" in
-- the Consolidated view once Indigo data went live. This seeds the code -> name map so
-- the existing join resolves them everywhere. Pure data; no schema change, no code deploy
-- needed (resolves on the next dashboard cache refresh).
--
-- SOURCE: the 37 (facility_code, facility_name) pairs mirror INDIGO_CUSTOMERS in
-- src/collections/cmdCustomers.ts EXACTLY (CMD account 474623; facilityCode == the CMD
-- customer id; names owner-confirmed). Keep the two in sync if the roster changes.
--
-- care_setting / display_acronym are LEFT NULL: Indigo has no IP/OP classification or
-- acronym scheme yet, so care_setting = NULL ("Other", never guessed) and the chart falls
-- back to the full facility_name for the bar label (same as any unclassified facility).
--
-- PHI: none (facilities is the non-PHI reference table). RLS is enabled on the table; this
-- migration runs as the owner (bypasses RLS). Idempotent: ON CONFLICT (facility_code) keeps
-- the name current without clobbering any later-seeded care_setting/display_acronym.
--
-- DEPENDENCY: 0006 (collections.facilities + facility_code PK). Mirrors the BXR seed there.

insert into collections.facilities (facility_code, facility_name, notes)
values
  ('10026460', '405 RECOVERY',                                                 'Indigo Billing (CMD 474623)'),
  ('10029373', 'ADDICTION FREE RECOVERY SERVICES',                             'Indigo Billing (CMD 474623)'),
  ('10029528', 'ADOLESCENT MENTAL HEALTH',                                     'Indigo Billing (CMD 474623)'),
  ('10031413', 'BRITE RECOVERY',                                               'Indigo Billing (CMD 474623)'),
  ('10028848', 'CALIFORNIA TREATMENT COLLECTIVE',                              'Indigo Billing (CMD 474623)'),
  ('10028842', 'COVENANT HILLS TREATMENT CENTERS',                            'Indigo Billing (CMD 474623)'),
  ('10021230', 'CROWN VIEW CO-OCCURRING INSTITUTE - 612335',                   'Indigo Billing (CMD 474623)'),
  ('10023916', 'CROWN VIEW PSYCHIATRIC INSTITUTE',                             'Indigo Billing (CMD 474623)'),
  ('10020687', 'HEALTHY LIFE RECOVERY',                                        'Indigo Billing (CMD 474623)'),
  ('10026624', 'HILLSIDE HORIZON FOR TEENS',                                   'Indigo Billing (CMD 474623)'),
  ('10033859', 'INTO THE LIGHT',                                               'Indigo Billing (CMD 474623)'),
  ('10032291', 'KIN WELLNESS',                                                 'Indigo Billing (CMD 474623)'),
  ('10030095', 'KNOX RECOVERY',                                                'Indigo Billing (CMD 474623)'),
  ('10036020', 'MADISON RECOVERY CENTER',                                      'Indigo Billing (CMD 474623)'),
  ('10034063', 'MAPSONG PC',                                                   'Indigo Billing (CMD 474623)'),
  ('10024431', 'MENTAL HEALTH CENTER OF SAN DIEGO',                            'Indigo Billing (CMD 474623)'),
  ('10030319', 'MENTAL HEALTH MODESTO',                                        'Indigo Billing (CMD 474623)'),
  ('10034979', 'MENTAL HEALTH TREATMENT AND STABILIZATION CENTER OF SACRAMENTO','Indigo Billing (CMD 474623)'),
  ('10036030', 'MISSOURI BEHAVIORAL HEALTH',                                   'Indigo Billing (CMD 474623)'),
  ('10034230', 'MY TEEN MENTAL HEALTH',                                        'Indigo Billing (CMD 474623)'),
  ('10026125', 'MY TIME RECOVERY, LLC',                                        'Indigo Billing (CMD 474623)'),
  ('10033867', 'NEW ORIGINS',                                                  'Indigo Billing (CMD 474623)'),
  ('10034901', 'NEXT FRONTIER RECOVERY',                                       'Indigo Billing (CMD 474623)'),
  ('10035913', 'NORTHERN CALIFORNIA MENTAL HEALTH',                            'Indigo Billing (CMD 474623)'),
  ('10021573', 'OPUS HEALTH',                                                  'Indigo Billing (CMD 474623)'),
  ('10031652', 'ORANGE COUNTY MENTAL HEALTH',                                  'Indigo Billing (CMD 474623)'),
  ('10032612', 'POSTPARTUM MENTAL HEALTH',                                     'Indigo Billing (CMD 474623)'),
  ('10035467', 'RESTORED HOPE RECOVERY',                                       'Indigo Billing (CMD 474623)'),
  ('10028595', 'REVIVAL MENTAL HEALTH',                                        'Indigo Billing (CMD 474623)'),
  ('10026159', 'SADDLEBACK RECOVERY',                                          'Indigo Billing (CMD 474623)'),
  ('10028219', 'SHINE MENTAL HEALTH',                                          'Indigo Billing (CMD 474623)'),
  ('10025950', 'SILICON VALLEY RECOVERY, LLC',                                 'Indigo Billing (CMD 474623)'),
  ('10033531', 'THE EDGE TREATMENT CENTER',                                    'Indigo Billing (CMD 474623)'),
  ('10033708', 'THE FORGE RECOVERY CENTER',                                    'Indigo Billing (CMD 474623)'),
  ('10029219', 'THRIVE MEDICAL SPECIALISTS',                                   'Indigo Billing (CMD 474623)'),
  ('10034039', 'TREADSTONE SERVICES PC',                                       'Indigo Billing (CMD 474623)'),
  ('10031547', 'VISALIA RECOVERY CENTER',                                      'Indigo Billing (CMD 474623)')
on conflict (facility_code) do update set
  facility_name = excluded.facility_name,
  notes = excluded.notes;
