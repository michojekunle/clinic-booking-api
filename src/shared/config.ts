export interface Config {
  readonly port: number;
  readonly databaseUrl: string;
  readonly apiKey: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env["PORT"] ?? 3000),
    databaseUrl: required("DATABASE_URL"),
    apiKey: required("API_KEY"),
  };
}
