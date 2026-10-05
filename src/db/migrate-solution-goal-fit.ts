/** Migration 40. Null keeps older saved ideas explicitly unassessed. */
export const SOLUTION_GOAL_FIT_MIGRATION_SQL = `
  ALTER TABLE solutions ADD COLUMN criteria_fit_json TEXT
    CHECK(criteria_fit_json IS NULL OR (json_valid(criteria_fit_json) AND json_type(criteria_fit_json) = 'array'));
  ALTER TABLE solutions ADD COLUMN first_test_json TEXT
    CHECK(first_test_json IS NULL OR (json_valid(first_test_json) AND json_type(first_test_json) = 'object'));
  ALTER TABLE solutions ADD COLUMN bigger_problem_json TEXT
    CHECK(bigger_problem_json IS NULL OR (json_valid(bigger_problem_json) AND json_type(bigger_problem_json) = 'object'));
  ALTER TABLE solutions ADD COLUMN slice_json TEXT
    CHECK(slice_json IS NULL OR (json_valid(slice_json) AND json_type(slice_json) = 'object'));
  ALTER TABLE solutions ADD COLUMN reviewed_criteria_fit_json TEXT
    CHECK(reviewed_criteria_fit_json IS NULL OR (json_valid(reviewed_criteria_fit_json) AND json_type(reviewed_criteria_fit_json) = 'array'));
`;
