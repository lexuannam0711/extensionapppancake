const DEFAULT_CONTROL_PLANE_URL = 'https://api.xnampersonal.id.vn';
const DEFAULT_SUPABASE_URL = 'https://dbxraxyytegqmzhygosc.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRieHJheHl5dGVncW16aHlnb3NjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzNzg2NDAsImV4cCI6MjA5MDk1NDY0MH0.aqu_UdG_j_Vrtc1nKmKNOLBW7TTbyX704JgiaCU4iIk';
const DEFAULT_UPDATE_MANIFEST_URL = 'https://api.xnampersonal.id.vn/v1/update-manifest';

function resolveClientConfig(env = process.env) {
  return {
    controlPlaneUrl: env.CONTROL_PLANE_URL || DEFAULT_CONTROL_PLANE_URL,
    supabaseUrl: env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY,
    updateManifestUrl: env.UPDATE_MANIFEST_URL || DEFAULT_UPDATE_MANIFEST_URL
  };
}

module.exports = {
  resolveClientConfig,
  DEFAULT_CONTROL_PLANE_URL,
  DEFAULT_SUPABASE_URL,
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_UPDATE_MANIFEST_URL
};
