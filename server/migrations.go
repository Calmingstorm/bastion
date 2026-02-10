package server

import "embed"

// MigrationsFS embeds the SQL migration files for use by the database package.
//
//go:embed migrations/*.sql
var MigrationsFS embed.FS
