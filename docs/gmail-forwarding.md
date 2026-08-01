# Reenvio de alertas a SES

La direccion de recepcion de V1 es `alertas@inbound.finance.castrodavid.dev`.

1. En el Gmail que actualmente recibe las alertas bancarias, abre **Configuracion** > **Ver toda la configuracion** > **Reenvio y correo POP/IMAP**.
2. En **Reenvio**, elige **Agregar una direccion de reenvio** e introduce la direccion anterior.
3. Gmail enviara un correo de confirmacion a esa direccion. SES lo guardara como MIME raw. Avisanos cuando hayas solicitado la confirmacion para recuperar el codigo de forma segura.
4. Pega el codigo en Gmail y activa el reenvio. Al inicio, deja una copia en Gmail.
5. Crea un filtro para Santander, primero con el remitente `santander@envio.santander.com.mx` y el asunto que incluya `Tu compra`, y reenvialo a la direccion de SES. Ajustaremos el filtro con los correos reales que lleguen.

No reenvies estados de cuenta, mensajes de seguridad ni correos ajenos a compras en V1.
