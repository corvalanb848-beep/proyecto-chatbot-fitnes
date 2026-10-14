# FitAI

FitAI es una aplicación web de bienestar con resumen semanal, registro local de nutrición, escaneo asistido de comidas y un mapa interactivo para actividades al aire libre.

La presentación de FitAI está integrada en la misma página y enlaza con las herramientas existentes. El asistente de bienvenida guarda preferencias y una meta semanal solo en el navegador. No crea una cuenta ni sincroniza información.

## Requisitos y ejecución local

Se necesita Node.js 18 o posterior. No se instalan paquetes adicionales: el servidor usa módulos incluidos en Node.

1. Abre una terminal en la carpeta del proyecto.
2. Copia `.env.example` a `.env` y pega tu clave de OpenAI en `OPENAI_API_KEY`.
   - PowerShell: `Copy-Item .env.example .env` y luego `notepad .env`.
   - CMD: `copy .env.example .env` y luego `notepad .env`.
3. En una cuenta de OpenAI con acceso a la API, reemplaza `replace_with_your_openai_api_key` por la clave real. No la compartas ni la pongas en `app.js`.
4. Ejecuta `npm start`.
5. Abre `http://localhost:3000` en Chrome, Edge o Safari.

El servidor lee `.env` al iniciar y escucha en `127.0.0.1:3000` por defecto. Para cambiar el puerto, ajusta `PORT`; para cambiar el modelo de visión, ajusta `OPENAI_VISION_MODEL` en `.env`. Detén el servidor con Ctrl+C. No ejecutes `index.html` directamente: el escáner y la API necesitan el servidor.

### Escanear comida y privacidad

La pantalla «Nutrición» permite tomar una foto con la cámara (el navegador solicitará permiso) o elegirla de la galería. La imagen se valida, reduce en el navegador a un máximo de 1024 píxeles y se convierte a JPEG con calidad 0,8 antes de enviarse a `/api/scan-food`. El servidor la envía a la API de visión de OpenAI; nunca expone la clave al navegador ni escribe la imagen en disco. `/api/scan-food/status` informa si la clave está configurada sin revelarla.

Los resultados estiman los alimentos visibles y sus calorías, porción, proteína, carbohidratos, grasas y, cuando se puede estimar, fibra. Puedes editar el nombre y los gramos: los nutrientes se ajustan proporcionalmente a la cantidad. «Agregar a mi diario nutricional» guarda la fecha, hora, cantidad y nutrientes estimados en `localStorage` de este navegador; el resumen diario se reconstruye al volver a abrir FitAI y puedes eliminar registros. No se guarda la foto. Los datos no se sincronizan entre dispositivos ni se asocian a una cuenta porque esta versión no tiene autenticación ni almacenamiento de usuarios.

La foto sí se transmite a OpenAI para analizarla: evita incluir personas, documentos u otra información privada en la imagen. La solicitud está sujeta a las condiciones y retención de datos de OpenAI. Una foto no permite conocer con precisión el peso, los ingredientes ocultos ni las calorías exactas; los valores son aproximados y no son consejo médico.

En esta copia no hay historial Git ni se encontró el antiguo componente de interfaz del escáner. Se conservó y reutilizó el endpoint de visión que seguía presente en `server.js`, y se reconstruyeron la pantalla, captura/selección, resultados editables y diario local alrededor de él.

El servidor aplica un límite básico por dirección IP a las solicitudes de análisis de alimentos. No hay límite comercial de uso por plan en el cliente.

### Mapa y actividad al aire libre

La sección Mapa usa Leaflet 1.9.4 y se inicializa una sola vez, al abrirla. El botón «Mi ubicación» solicita permiso solo al pulsarlo y centra el mapa; no guarda coordenadas ni registra recorridos. La copia actual no contiene la antigua búsqueda Nominatim ni funciones para grabar, guardar o consultar rutas. La interfaz lo indica en vez de simularlas.

El proveedor de teselas se configura mediante `MAP_TILE_URL` y `MAP_TILE_ATTRIBUTION` en `.env`; el endpoint local `/api/map-config` entrega esos valores al navegador. El valor inicial usa `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` y muestra la atribución enlazada a OpenStreetMap. No se descarga en lote ni se precargan teselas fuera del área visible. Si las teselas fallan, el mapa muestra un aviso y un enlace para continuar en OpenStreetMap.

El error HTTP 403 «App is not following the tile usage policy» confirma que el servidor de teselas rechazó esas solicitudes por su política, pero el código eliminado no está disponible y no es posible demostrar qué condición concreta lo provocó (por ejemplo, falta de atribución/referrer válido, patrón de tráfico o política del proveedor). En la sección restaurada se incluye atribución visible y Leaflet carga una única capa bajo demanda; el navegador conserva el control de cabeceras como `User-Agent` y `Referer`. Esto mejora la integración, pero no garantiza que el servicio comunitario acepte tráfico de una aplicación publicada ni ofrece un SLA. Para producción o tráfico significativo, configura un proveedor de teselas con permiso de uso adecuado y su URL pública de estilo/teselas en `MAP_TILE_URL`, junto con su atribución exacta en `MAP_TILE_ATTRIBUTION`. No pongas secretos en estas variables si el proveedor los considera credenciales privadas: la URL se expone al navegador; usa solo tokens públicos restringidos por dominio.

La geolocalización requiere permiso explícito y HTTPS o `localhost`. Esta copia centra el mapa en la ubicación solicitada, pero no inicia ni registra recorridos.

### Registros locales y estimaciones

El progreso, las preferencias y las comidas se almacenan en el navegador y no se sincronizan con otros dispositivos. FitAI no calcula calorías quemadas ni obtiene datos de dispositivos. Las estimaciones visuales, nutricionales y GPS no son mediciones clínicas: «Son estimaciones aproximadas, no reemplazan el consejo de un profesional».

## Planes y chat

La presentación comercial describe las funciones gratuitas que sí están disponibles y marca Premium como una propuesta futura. Premium no tiene precio confirmado, suscripción ni procesamiento de pagos. La rutina inicial, el diario local, el mapa y el escáner configurado siguen disponibles sin bloqueo comercial.

Los guiones de campaña son borradores copiables: FitAI no está conectado a redes sociales ni publica contenido. El botón para compartir usa las capacidades de compartir del navegador cuando están disponibles; no crea códigos de referidos ni contabiliza conversiones.

Las métricas de marketing son opcionales, requieren consentimiento y, si se aceptan, se guardan únicamente en este navegador por un máximo de 90 días y 500 eventos. No se envían al servidor ni incluyen texto de comidas, imágenes, datos de salud, nombre o email. No representan visitantes únicos ni permiten medir usuarios activos, registros reales o conversiones entre dispositivos. Se pueden desactivar y borrar desde «Privacidad de métricas».

La página incluye metadatos de título y descripción y metadatos Open Graph sin imagen social. No se configura canonical, sitemap ni preview de marca porque todavía no hay un dominio público ni un recurso gráfico de marca verificado. Antes del lanzamiento hay que confirmar dominio, email de contacto, perfiles oficiales, textos legales y una imagen OG optimizada.

## Integraciones reales pendientes

### Asistente de IA

El chat de esta versión solo muestra el mensaje escrito por la persona y no genera respuestas ni envía datos. Para conectarlo, crea un backend autenticado, usa una clave guardada en una variable de entorno del servidor y añade controles de abuso y una política de privacidad.

### Premium y pagos

No hay precio confirmado ni se solicita o procesa ningún pago. Para habilitar suscripciones necesitas elegir un proveedor de pagos (por ejemplo, Stripe), un backend y sus claves secretas almacenadas como variables de entorno del servidor. El backend debe crear la sesión de checkout y validar webhooks firmados antes de conceder acceso Premium. No aceptes el estado de pago desde el cliente.

### Persistencia de cuenta

La actividad se guarda únicamente en el navegador actual. Una versión con cuentas sincronizadas necesitará autenticación y una base de datos en un backend; no expongas credenciales de base de datos en código cliente.
