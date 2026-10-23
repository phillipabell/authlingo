// Renders one template with Go's own template engine (the engine Supabase Auth uses), for authlingo preview and the
// fidelity tests. stdin: {"template": "...", "data": {...}, "html": true}. stdout: rendered text; exit 1 on error.
package main

import (
	"encoding/json"
	htmltpl "html/template"
	"io"
	"os"
	"strings"
	texttpl "text/template"
)

type req struct {
	Template string                 `json:"template"`
	Data     map[string]interface{} `json:"data"`
	HTML     bool                   `json:"html"`
}

func main() {
	var r req
	if err := json.NewDecoder(os.Stdin).Decode(&r); err != nil {
		fail(err)
	}
	var sb strings.Builder
	var err error
	if r.HTML {
		var t *htmltpl.Template
		if t, err = htmltpl.New("t").Parse(r.Template); err == nil {
			err = t.Execute(&sb, r.Data)
		}
	} else {
		var t *texttpl.Template
		if t, err = texttpl.New("t").Parse(r.Template); err == nil {
			err = t.Execute(&sb, r.Data)
		}
	}
	if err != nil {
		fail(err)
	}
	io.WriteString(os.Stdout, sb.String())
}

func fail(err error) { os.Stderr.WriteString(err.Error() + "\n"); os.Exit(1) }
