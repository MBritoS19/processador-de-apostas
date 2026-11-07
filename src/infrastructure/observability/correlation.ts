/** `correlationId` vindo de fora (header HTTP, envelope SQS): curto e sem caracteres de controle. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
