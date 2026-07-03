{{- define "pikdame.name" -}}
{{ .Chart.Name }}
{{- end }}
{{- define "pikdame.labels" -}}
app.kubernetes.io/name: {{ include "pikdame.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "pikdame.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pikdame.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
