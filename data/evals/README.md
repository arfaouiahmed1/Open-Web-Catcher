# Evaluation CSV Templates

Each CSV in this folder is a placeholder dataset for the notebook lab in [`notebooks/06_agent_evaluation_lab.ipynb`](C:/Users/ahmed/Desktop/PFE%20New%20Test/notebooks/06_agent_evaluation_lab.ipynb).

## Workflow

- Duplicate the placeholder rows.
- Replace the sample URL with a real target.
- Set `enabled` to `true` for cases you want the notebook to run.
- Fill only the expectation columns you actually know.

## Shared Columns

- `case_id`: stable identifier for the test case
- `enabled`: `true` or `false`
- `url`: page URL to run
- `tags`: pipe-separated labels like `football|cloudflare|hard`
- `notes`: free-form analyst note
- `expected_page_type`: expected classifier output such as `landing_page`, `hosting_page`, or `embedded_page`
- `confidence_at_least`: `low`, `medium`, or `high`
- `expected_final_status`: usually `success`, `partial`, or `failed`
- `min_streams` / `max_streams`: expected stream-count range
- `min_hosting_pages`: landing-page expectation
- `min_embedded_urls`: hosting-page handoff expectation
- `requires_provider_analysis`: `true` when provider analysis must exist
- `requires_email_targets`: `true` when takedown emails must exist
- `required_tools` / `forbidden_tools`: pipe-separated tool names
- `max_tool_errors`: allowed tool failures in the trace
- `expected_provider_keywords`: pipe-separated provider/org keywords
- `expected_stream_host_keywords`: pipe-separated stream-host keywords
- `expected_hosting_url_keywords`: pipe-separated landing-result URL keywords
- `expected_embedded_url_keywords`: pipe-separated embedded-result URL keywords
- `expected_failure_mode`: substring expected in the failure output when the case should fail
