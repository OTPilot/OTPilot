# OTPilot mobile (iOS + Android) — plan

> **Decidido (2026-10-13):**
> - **Tecnología:** Expo / React Native "local-first", igual que Pomodoso (`~/code/pomodoso/mobile`, ADR 0002 de ese repo). Una sola base de código para iOS y Android. Lo nativo (autofill del sistema, biometría, Keychain/Keystore) va en módulos Expo propios en `mobile/modules/` y config plugins, como el Live Activity y el IAP de Pomodoso. Builds locales con `make`, sin EAS hasta que haga falta.
> - **Free en el celular:** la app funciona completa y **solo local**, sin sync. Un usuario Free usa el navegador **o** el celular. Para pasar los datos de uno al otro, exporta un backup cifrado y lo importa (el mismo formato v2 de la extensión). El sync entre dispositivos sigue siendo de Personal y Team.
> - **Temas:** solo **dark** y **light** (sigue al sistema, con override en Settings). Los temas de la extensión (Original, Sepia, etc.) no van.
> - **Safari / Firefox:** no por ahora. Edge ya funciona porque es compatible con Chrome. Safari, cuando algún usuario lo pida.
>
> Mockups: ver la sección 9.

## 0. Objetivo

Que OTPilot esté en el celular con lo que hace en el navegador:
- contraseñas y códigos 2FA completados donde se inicia sesión, ahora **en cualquier app** con el autofill del sistema;
- el vault cifrado de punta a punta;
- el autenticador (los códigos 2FA a mano, como Google Authenticator);
- aprobar a los agentes de IA desde el teléfono.

Es decir, la paridad con la extensión, salvo lo que solo tiene sentido dentro de una página web (sección 3).

## 1. Arquitectura

### 1.1 Stack (copiado de Pomodoso)

| Pieza | Elección | Notas |
|---|---|---|
| App | Expo + expo-router, React Native, TypeScript | Igual que Pomodoso. |
| Navegación | Bottom tabs | Ver mockups, opción A vs. B. |
| Almacenamiento local | `expo-sqlite`: una fila por registro cifrado (`id`, `record` JSON, `revision`, `deleted_at`) | Mismo modelo que `VaultStore` (`vi:<id>` / `vt:<id>`), pero en SQLite. Nunca se guarda nada en claro, salvo el índice (1.4). |
| Secretos del dispositivo | `expo-secure-store` + módulo propio para Keychain/Keystore **con biometría** | La vault key envuelta con la master password, y una copia protegida por Face ID / huella (1.3). |
| Auth | Supabase (`@supabase/supabase-js` con un storage adapter sobre secure-store) | Igual que Pomodoso y que la extensión: Google y magic link. |
| Cámara / QR | `expo-camera` (escaneo de códigos de barras) | Para agregar 2FA y para la transferencia de Google Authenticator. |
| Notificaciones | `expo-notifications`, **push remoto** (APNs/FCM) | Hace falta para los pedidos de agentes (sección 6, fase M4). En Pomodoso todavía es solo local. |

### 1.2 Cripto: el mismo código que la extensión, no un port

La extensión ya comparte su cripto con otro cliente: el MCP carga `vaultCrypto.js`, `vault.js` y `totp.js` desde `vendor/` (copiados de `extension/` en el build). El móvil hace lo mismo. **No se reescribe la cripto en TS.**

- WebCrypto (`crypto.subtle`) no existe en React Native: se usa `react-native-quick-crypto`, que lo implementa en nativo (AES-GCM, PBKDF2-SHA256, ECDH P-256, con JSI). Hay que **verificarlo en el spike M0**, en particular PBKDF2 con 600k iteraciones en un teléfono de gama media: tiene que tardar menos de ~1 s.
- **Tercer cliente de los fixtures:** `web/src/lib/__fixtures__/vault-crypto.json` tiene datos hechos por la extensión y por la web, y cada lado abre los del otro. El móvil se agrega como tercer cliente: abre los dos y agrega los suyos. Lo mismo vale para el código Swift y Kotlin del autofill (1.4): sus tests corren sobre los mismos fixtures.
- **Sync:** el mismo protocolo `/vault/items` (pull paginado con cursor, push con `base_revision`, batch de creación, `taken` / `conflicts`, tombstones). `vaultSync.js` depende de `VaultStore` y `chrome.storage`. Se le extrae la lógica (`applyPulled`, `push`, `rehome`) a un módulo puro con un `store` inyectable, que la extensión y el móvil comparten. Es lo que en Pomodoso **no** se hizo (ahí cada cliente reimplementó el sync y divergieron). Acá el sync tiene casos borde caros (twins, `rehome`, shares que viven en el ítem), así que vale la pena.

### 1.3 Desbloqueo

- **Primera vez:** master password, con el mismo wrap PBKDF2 de la extensión (`vaultKeyWrapped`).
- **Después:** Face ID / Touch ID / huella. Una copia de la vault key queda en el Keychain (iOS, `kSecAccessControlBiometryCurrentSet`) o en el Keystore (Android, `setUserAuthenticationRequired` + BiometricPrompt). Si cambian las biometrías del dispositivo, esa copia se invalida y se pide la master password.
- **Auto-lock:** las mismas opciones que en la extensión (inmediato, 1 min, 5, 15, 1 h). También se bloquea al pasar a background, según la opción elegida.
- **Recovery key:** igual que en la extensión: se muestra una vez, y sirve para "olvidé la master password" (es la vault key).

### 1.4 Autofill del sistema (lo que hace que se use todos los días)

| | iOS | Android |
|---|---|---|
| API | **Credential Provider Extension** (`ASCredentialProviderViewController`): contraseñas y, desde iOS 18, **códigos 2FA** (`ASOneTimeCodeCredential`) | **AutofillService** (Android 8+) y **Credential Manager provider** (Android 14+) |
| Proceso | Un *target* aparte (app extension), con un límite de memoria bajo (~120 MB). No puede cargar React Native. | Un servicio del sistema, que puede ser Kotlin puro. |
| Código | **Swift**, en un módulo Expo con config plugin que agrega el target | **Kotlin**, en un módulo Expo |
| Datos | Los lee de un **App Group** compartido | Los lee de su propio almacenamiento |

**Diseño de seguridad, el mismo invariante que la extensión:**
- Un **índice sin secretos** (nombre, dominios, si tiene contraseña o 2FA; como `vaultIndex`) permite que el sistema sugiera la cuenta antes de desbloquear.
- La contraseña o el código se descifran **solo al elegir la cuenta**, después de Face ID, dentro de la extensión: Swift/Kotlin descifran el registro del ítem con la vault key del Keychain/Keystore.
- **El matching de dominios es el mismo `loginCoversHost`:** el host o un subdominio, nunca el padre ni un hermano. Para apps, se usan los *associated domains* de la app que pide la contraseña.

Esto implica cripto de ítems en **Swift (CryptoKit)** y **Kotlin (javax.crypto)**, probada con los fixtures. Es la parte más delicada del proyecto.

### 1.5 Código compartido

```
otpilot/
  extension/        (fuente de vaultCrypto.js, vault.js, totp.js)
  mcp/vendor/       (copia generada)
  mobile/
    vendor/         (copia generada, igual que el MCP: nunca se edita)
    app/            expo-router
    modules/
      otpilot-autofill/   Swift (Credential Provider) + Kotlin (AutofillService)
      otpilot-keychain/   vault key con biometría
    plugins/        config plugins (target de AutoFill, App Group, entitlements)
```

`vaultSync` puro: se extrae a `extension/vaultSyncCore.js`, que usan la extensión y `mobile/vendor/`.

## 2. Inventario de funcionalidades de la extensión, y su equivalente móvil

Leyenda de **Fase**: M1 = primera versión publicada, M2 = autofill, M3 = paridad, M4 = agentes y extras, — = no aplica.

### 2.1 Vault e ítems

| Funcionalidad (extensión) | Móvil | Fase |
|---|---|---|
| Logins: nombre, usuario, contraseña, URLs, 2FA, notas, tags (categoría + más tags) | Igual | M1 lectura, M3 edición |
| Tipos: nota segura, servidor, credencial de API | Igual | M1 lectura, M3 edición |
| Tipos "Soon" (SSH, base de datos, Wi-Fi, tarjeta, banco, dirección, documento, tipo propio) | Igual que en la extensión, "Soon". **Tarjeta** y **Wi-Fi** suman mucho en el celular (autofill de tarjeta; compartir Wi-Fi con QR) | Después |
| Campos propios por secciones (texto, oculto, email, fecha, multilínea) | Igual | M3 |
| Ítems relacionados (links + backlinks, "nueva nota vinculada") | Igual | M3 |
| Historial de contraseñas | Ver y copiar | M3 |
| Merge de dos logins | Solo en la extensión al principio | Después |
| Free: límite de 50 ítems (`countsForLimit`: los logins que solo tienen 2FA no cuentan) | El mismo límite y el mismo conteo | M1 |
| Filtros: tags (cualquiera de varios), tipo, "con código 2FA", chips activos | Igual, en una hoja de filtros | M1 |
| Búsqueda | Igual | M1 |
| Íconos de sitios (`/icons/resolve` + caché local) | Igual, caché en SQLite | M1 |
| Ítems compartidos conmigo ("Shared · <persona/colección>") | Se ven en la lista, con su etiqueta | M3 |

### 2.2 2FA / autenticador

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Código TOTP en vivo con cuenta regresiva | **Pantalla principal del autenticador** (opción A de los mockups) | M1 |
| Copiar código | Toque y copia, con el portapapeles marcado como sensible y borrado a los 60 s | M1 |
| Ocultar / ofuscar códigos | Igual (ojito); opción "mostrar códigos solo con Face ID" | M1 |
| Agregar 2FA leyendo el QR de una página (content script) | **Cámara: escanear el QR** de la pantalla de la computadora o de una captura | M1 |
| `otpauth://` pegado o como link | Igual, y además **abrir links `otpauth://`** (la app se registra para ese esquema) | M1 |
| Importar de Google Authenticator (QR de "Transfer accounts") | Cámara o captura de pantalla | M1 |
| "2FA code" compacto (secret primero) | Igual | M1 |
| Autofill de código en el campo OTP de la página | Autofill del sistema: iOS 18+ con códigos de un solo uso; Android Autofill | M2 |
| Códigos por email leídos del webmail abierto | **No aplica** (sección 3). iOS y Android ya completan códigos de **SMS**. | — |

### 2.3 Autofill y guardado

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Badge en los campos, desplegable con los logins | El sistema muestra la sugerencia en el teclado (QuickType) o el menú de autofill | M2 |
| Fill de usuario + contraseña con un clic | Elegir la cuenta → Face ID → completa | M2 |
| Coincidencia estricta de host (`loginCoversHost`) | La misma regla; en apps, por *associated domains* | M2 |
| Varias cuentas para el mismo sitio | El sistema las lista todas | M2 |
| Guardar un login nuevo al iniciar sesión / actualizar contraseña | iOS: *Save password* (proveedor de credenciales, iOS 18+). Android: `onSaveRequest` | M2 |
| Sugerir contraseña en campos de contraseña nueva | iOS: el sistema sugiere la suya; con proveedor propio se puede ofrecer la de OTPilot. Android: desde el servicio de autofill | M3 |
| "Open & sign in" (abrir el sitio y loguearse) | Abrir el sitio en el navegador; el autofill del sistema hace el resto | M3 |
| Auto-submit, detección de auto-submit fallido (`noAutoSubmit`) | **No aplica**: el sistema no envía formularios | — |
| Desbloqueo dentro de la página (frame) | Face ID dentro de la hoja de autofill | M2 |

### 2.4 Generador

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Contraseña (8–64) o PIN (4–12), mayúsculas, minúsculas, números, símbolos, evitar caracteres parecidos, fuerza en bits | Igual: la pestaña Generate | M1 |
| Historial de copiados de la sesión (últimos 10, solo en memoria) | Igual, solo en memoria | M1 |

### 2.5 Seguridad y cuenta

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Master password obligatoria, setup, cambio | Igual + biometría | M1 |
| Auto-lock (15/60/240/480 min, al cerrar) | Opciones móviles (1.3) | M1 |
| Recovery key (mostrar una vez, revelar con la master password, recuperar) | Igual | M1 |
| Reset del dispositivo ("empezar de cero") | Igual | M1 |
| Sign in (Google / magic link), sign out | Igual | M1 |
| Plan y upgrade (Stripe) | Link a la web para pagar (como Pomodoso hoy); IAP nativo más adelante (ADR 0003 de Pomodoso) | M1 link, después IAP |
| Captura de pantalla | Bloqueada en pantallas con secretos (Android `FLAG_SECURE`; iOS: ocultar al pasar a background / app switcher) | M1 |

### 2.6 Sync y datos

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Sync por ítem `/vault/items` (Personal/Team) | Igual, con el core compartido (1.2) | M1 |
| Free: sin sync | Solo local (decidido) | M1 |
| Backup cifrado v2: exportar / importar, con "nuevo / más nuevo / ya está" | Igual, con el share sheet / document picker. **Es el puente de Free entre navegador y celular** | M1 |
| Export / import CSV | Importar CSV sí; exportar CSV con advertencia | M3 |
| Importar de otros password managers (CSV) | Igual (document picker) | M3 |
| Migración v1 → v2 | **No aplica**: el móvil nace en v2 | — |
| Dispositivos (lista, desconectar, borrar a distancia) | El móvil se registra como dispositivo y responde a "disconnect" / "erase" en el próximo sync | M1 |

### 2.7 Equipos y compartir

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Invitaciones (aceptar / rechazar) | Igual, en la campana | M3 |
| Notificaciones ("te agregaron a una colección", "te compartieron un ítem") | Igual, y con push | M3 |
| Compartir un ítem (hoja de Share: con quién, qué, ver/editar, resumen) | Igual | M3 |
| Colecciones (crear, miembros, roles, ítems) | Ver y usar en M3; administrar puede quedar en la extensión/web | M3 / después |
| Códigos 2FA compartidos 2-of-2 (código en vivo sin el secreto) | Ver y copiar el código | M3 |

### 2.8 Agentes de IA (2.1)

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Ver agentes, verificar el código, aprobar | Igual | M4 |
| **Pedidos de cuenta / "preguntar cada vez"** | **Push: "Claude Code quiere usar GitHub"** → aprobar con Face ID. Es la función que mejor encaja en el celular: aprobar mientras estás lejos de la computadora | M4 |
| Agregar cuenta a un agente (alcance, duración, comandos) y Renew | Igual | M4 |
| Actividad, revocar | Igual | M4 |
| Free: 1 agente, 3 cuentas | Igual | M4 |

### 2.9 Apariencia

| Funcionalidad | Móvil | Fase |
|---|---|---|
| Temas (varios) | **Solo dark y light**, siguiendo al sistema, con override | M1 |

## 3. Lo que no aplica en el móvil (y qué lo reemplaza)

Todo lo que vive en content scripts dentro de una página:
- **Detectar 2FA en la página** (QR, `otpauth://`, texto plano) → la cámara y los links `otpauth://`.
- **Leer códigos del webmail abierto** (`email-reader.js`) → no hay equivalente posible: una app no puede leer otra. El sistema ya completa los códigos por SMS.
- **Auto-submit y su autocorrección** → el sistema completa; el envío lo hace la persona.
- **Badges, desplegables y ofertas de guardado en la página** → la UI de autofill del sistema.
- **Frame de desbloqueo en la página** → Face ID en la hoja de autofill.
- **Ofuscación en la página / tema de la UI inyectada** → no aplica.

## 4. Planes

| | Free | Personal | Team |
|---|---|---|---|
| App móvil | ✅ completa, **solo local** | ✅ | ✅ |
| Sync navegador ↔ celular | ❌ (export/import cifrado) | ✅ | ✅ |
| Ítems | 50 (los 2FA solos no cuentan) | ilimitados | ilimitados |
| Autofill del sistema | ✅ | ✅ | ✅ |
| Agentes | 1 agente, 3 cuentas | ilimitados | ilimitados |
| Compartir | — | — | ✅ |

**Para decidir:** en Free, ¿el celular es "otro dispositivo" o comparte el límite? Hoy Free no tiene límite de dispositivos porque no sincroniza. Propuesta: **no limitar**. Cada instalación es un vault local independiente, y la diferencia con pagar es el sync.

## 5. Pantallas

Ver mockups (sección 9). Lista completa:

1. Bienvenida (Free local vs. iniciar sesión)
2. Crear master password + activar Face ID
3. Recovery key (guardarla)
4. Desbloqueo (Face ID / master password)
5. **Códigos** (autenticador) — opción A como tab propio, opción B integrado al vault
6. **Vault** (lista, búsqueda, filtros)
7. Hoja de filtros (tags, tipo, con 2FA)
8. Detalle de un login (copiar, mostrar, 2FA en vivo, relacionados, compartido con)
9. Editor de ítem (campos, campos propios, tags)
10. Agregar: elegir tipo / escanear QR
11. Escáner de QR
12. Generador
13. Agentes: pedido entrante (push → aprobar) — opción A pantalla completa, opción B hoja inferior
14. Agentes: lista y detalle
15. Compartir (hoja de Share)
16. Ajustes
17. Cuenta y sync (Free / Personal)
18. Activar el autofill del sistema (guía paso a paso iOS / Android)
19. Autofill en uso (cómo se ve en iOS y Android)

## 6. Fases

### M0 — Spike (validar lo riesgoso antes de construir)
- Expo + `react-native-quick-crypto`: abrir los fixtures de `vault-crypto.json`; medir PBKDF2 600k en un teléfono real.
- Módulo de Keychain/Keystore con biometría: guardar y leer la vault key.
- **Credential Provider (iOS) mínimo** en un target agregado por config plugin, que lea un ítem cifrado del App Group y lo descifre en Swift con un fixture. Es el riesgo principal.
- AutofillService (Android) mínimo, igual que lo anterior en Kotlin.

### M1 — Primera versión publicada: autenticador + vault de solo lectura
- Bienvenida, master password, Face ID, recovery key, desbloqueo, auto-lock.
- Códigos (autenticador) con cámara QR, `otpauth://`, importar de Google Authenticator.
- Vault: lista, búsqueda, filtros, detalle, copiar.
- Generador.
- Free local + backup cifrado export/import; sync para Personal/Team con el core compartido; registro como dispositivo.
- Dark/light.

### M2 — Autofill del sistema
- iOS Credential Provider (contraseñas + códigos en iOS 18), Android AutofillService (+ Credential Manager).
- Guardar logins nuevos y actualizar contraseñas.

### M3 — Paridad
- Edición de todos los tipos, campos propios, relacionados, tags.
- Compartir, colecciones, invitaciones, notificaciones.
- Importar CSV.

### M4 — Agentes y extras
- Push remoto (APNs/FCM): pedidos de agentes y "preguntar cada vez" aprobados con Face ID.
- Lista, detalle, agregar cuenta, actividad, revocar.
- Tarjeta y Wi-Fi como tipos nuevos (si se decide), IAP.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| La cripto del autofill (Swift/Kotlin) no coincide con la de JS | Los fixtures `vault-crypto.json` como tests obligatorios en las tres implementaciones; spike M0. |
| PBKDF2 600k lento en teléfonos | Cripto nativa (quick-crypto); después del primer desbloqueo, la biometría evita repetirlo. |
| Memoria de la extensión de AutoFill en iOS | Swift sin RN, índice chico, descifrar un solo ítem. |
| Review de Apple / Google para un password manager | Declarar el uso de cifrado (`ITSAppUsesNonExemptEncryption` = true; cifrado estándar, autoclasificación de exportación). Política de privacidad ya publicada. Probar el autofill en TestFlight / beta cerrada. |
| El sync diverge entre clientes (lo que pasó en Pomodoso) | Core de sync compartido (1.2), no reimplementado. |
| Push de agentes revela datos | La notificación dice agente + nombre de la cuenta (que ya es el label que el agente puede leer). Nunca un valor. |
| Portapapeles | Copias marcadas como sensibles (iOS `UIPasteboard` local + expiración; Android `ClipDescription.EXTRA_IS_SENSITIVE`), borradas a los 60 s. |

## 8. Costos y cuentas

- Apple Developer Program: USD 99/año (¿ya existe la de Pomodoso, team `35392GG43S`? se puede usar la misma).
- Google Play Console: USD 25, pago único.
- APNs y FCM para el push (M4).
- Bundle id propuesto: `app.otpilot.mobile` (iOS y Android), App Group `group.app.otpilot`.

## 9. Mockups

Canvas de diseño: https://claude.ai/artifact/DPzox3yJ2hx5gfYYrVCp19 (privado; compartirlo desde su menú Share). Tiene 22 pantallas, una por artboard. Cada una tiene un tweak **dark** para verla en el otro tema: el canvas muestra algunas en dark y otras en light. Hay opciones donde hay que decidir:
- **Inicio:** 05A, los códigos en su propio tab (5 tabs: Codes · Vault · Generate · Agents · Settings), vs. 05B, una sola lista con el código en vivo en cada fila (4 tabs).
- **Pedido de un agente:** 13A, pantalla completa con "Allow with Face ID" (un pedido de "preguntar cada vez"), vs. 13B, una hoja inferior (un pedido de cuenta nueva, eligiendo la cuenta, el alcance y la duración).

Paleta: la de la extensión (dark navy con acento cielo; light claro con acento azul oscuro, que tiene contraste AA sobre blanco).
