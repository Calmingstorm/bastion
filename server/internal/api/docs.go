package api

import (
	_ "embed"
	"net/http"
)

//go:embed docs/openapi.yaml
var openapiSpec []byte

//go:embed docs/swagger.html
var swaggerHTML []byte

func ServeAPIDocs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write(swaggerHTML)
}

func ServeOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/yaml")
	w.WriteHeader(http.StatusOK)
	w.Write(openapiSpec)
}
