# Luna PG‑ADMIN – Front‑end

Interface web para administração da plataforma Luna. Permite gerir
instâncias UAZAPI, visualizar chats, mensagens e acionar a geração de
relatórios de análise de conversas.

## Exportação de conversas

Na tela de conversas existe um botão **Exportar** que envia as
mensagens recentes da instância atual para análise pela IA. A
implementação faz uma requisição `POST` para a rota
`/api/instances/:id/export-analysis` e faz o download do PDF
retornado. A lógica de exportação encontra-se em
`conversas.js` na função `doExportCurrentInstance()`.

## Uso

Abra `index.html` em um navegador moderno ou hospede os arquivos em um
servidor estático. Configure as variáveis de ambiente do backend
(`FRONT_ORIGINS`, `CORS_ORIGINS`) para permitir o acesso da origem
desejada.