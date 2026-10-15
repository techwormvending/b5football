/* Supabase connection for the browser. Both values are PUBLIC by design:
   the publishable key only grants what the database's row-level security
   policies allow (see supabase/migrations). Safe to commit.

   NEVER put the secret / service_role key here or anywhere in this repo.
   Server-side jobs read it from the GitHub Actions secret SUPABASE_SERVICE_ROLE_KEY. */
window.B5_SUPABASE = {
  // Project "b5ffl" (Supabase dashboard > Data API > API URL, without /rest/v1/).
  url: "https://kngwdttpbpezlvjrkrrg.supabase.co",
  publishableKey: "sb_publishable_R3WkEHEDPyxtLW8sWRUfEA_JuhNvgNg"
};

/** True once the real project URL has been filled in. */
window.B5_SUPABASE.configured = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(window.B5_SUPABASE.url);
