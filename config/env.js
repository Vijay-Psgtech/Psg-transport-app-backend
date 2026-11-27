const REQUIRED_VARIABLES = ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

export function validateEnvironment(env = process.env) {
  const missing = REQUIRED_VARIABLES.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and set these values.`
    );
  }

  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (env[key].length < 32) {
      throw new Error(`${key} must contain at least 32 characters. Generate a unique random secret for each key.`);
    }
  }

  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }

  if (
    env.REFRESH_COOKIE_SAME_SITE &&
    !['strict', 'lax', 'none'].includes(env.REFRESH_COOKIE_SAME_SITE.toLowerCase())
  ) {
    throw new Error('REFRESH_COOKIE_SAME_SITE must be strict, lax, or none.');
  }
}