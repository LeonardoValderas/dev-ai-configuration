# DAC Brief Studio

DAC Brief Studio es un formulario HTML estático para transformar una idea en dos artefactos complementarios:

- **PRD Markdown**: documento editable de producto que define alcance, usuarios, requisitos, riesgos y condiciones de entrega.
- **Prompt DAC**: texto para pegar en Codex CLI o Claude Code. Incluye el PRD y solicita la planificación Full SDD en modo read-only, sin autorizar implementación ni persistencia.

## Abrir

Desde la raíz del repositorio:

```bash
open tools/brief-studio/index.html  # macOS
```

En otras plataformas, abrir `tools/brief-studio/index.html` en un navegador local. No requiere servidor, dependencias ni cuenta.

## Uso

1. Definir proyecto, tipo de trabajo y alcance (prototipo, MVP productivo, producto completo o nueva funcionalidad).
2. Describir problema, objetivo, usuarios, funcionalidades y criterios observables.
3. Decidir qué áreas de producción aplican: seguridad, datos, calidad, despliegue, monitoreo y mantenimiento.
4. Guardar el PRD Markdown en el repositorio del proyecto cuando corresponda.
5. Copiar **Prompt DAC** en Codex CLI o Claude Code para iniciar la planificación read-only.
6. Revisar el plan SDD generado. El handoff, `dac sdd apply`, `dac implement` y `dac review` mantienen sus autorizaciones y controles separados.

## Privacidad y conservación

El HTML no envía el contenido del formulario a un servicio remoto. Guarda automáticamente un borrador en `localStorage` del navegador, cuando el navegador permite usarlo en archivos locales. No introducir credenciales, secretos ni datos de clientes sin evaluar ese almacenamiento. «Limpiar» elimina el borrador de la página y del almacenamiento local disponible.

## Comprobaciones de aceptación al integrarlo

- Abrir el HTML sin servidor e introducir un producto completo; verificar que los seis dominios de producción aparezcan en PRD y Prompt DAC.
- Seleccionar prototipo, MVP productivo y funcionalidad existente; verificar la distinción de alcance.
- Confirmar que el Prompt DAC incluye el PRD íntegro y exige planificación sin escritura.
- Copiar y descargar ambos outputs; confirmar el contenido y nombre de los archivos Markdown.
- Cargar ejemplo de calculadora y borrar el formulario; comprobar la persistencia/limpieza según navegador.
- Probar teclado, foco visible y ausencia de desbordamientos en escritorio y móvil.
- Confirmar que el formulario no abre conexiones de red al generar o descargar documentos.

## Fuera de alcance

No genera contratos de tareas ni paths autorizados sin inspeccionar un repositorio; no modifica archivos SDD; no concede aprobaciones y no ejecuta Codex/Claude. No es un generador de aplicaciones.
