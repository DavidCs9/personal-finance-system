# Reenvío de alertas a SES

La dirección de recepción de V1 es `alertas@inbound.finance.castrodavid.dev`.

1. En el Gmail que actualmente recibe las alertas bancarias, abre **Configuración** > **Ver toda la configuración** > **Reenvío y correo POP/IMAP**.
2. En **Reenvío**, elige **Agregar una dirección de reenvío** e introduce la dirección anterior.
3. Gmail enviará un correo de confirmación a esa dirección. SES lo guardará como MIME raw. Avisa cuando hayas solicitado la confirmación para recuperar el código de forma segura.
4. Pega el código en Gmail y activa el reenvío. Al inicio, deja una copia en Gmail.
5. Crea filtros que reenvíen solo alertas de compra / cargo / transferencia / facturación. Punto de partida:

| Emisor | Remitente / pista | Asunto o cuerpo (aproximado) |
| --- | --- | --- |
| Santander | `santander@envio.santander.com.mx` | incluye `Tu compra` / compra o cargo |
| American Express | cuerpo con “American Express” | alertas de compra con tarjeta |
| Nu | `nu@nu.com.mx` / `nu.com.mx` | `Transferencia fue exitosa` |
| AWS Billing | `invoicing@aws.com` | `Amazon Web Services Billing Statement Available` |

Ajusta cada filtro con los correos reales que lleguen. El parser de confirmación de Gmail (`forwarding-noreply@google.com`) se ignora a propósito.

No reenvíes estados de cuenta, mensajes de seguridad ni correos ajenos a compras o cargos en V1.
