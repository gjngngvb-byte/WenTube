# WenTube API

Uma API pequena em Node.js para receber um link autorizado e devolver o arquivo como download. Ela usa `yt-dlp` e FFmpeg dentro de um contêiner Docker.

> **Uso responsável:** baixe somente conteúdo que você tem autorização para baixar. Respeite direitos autorais, termos do serviço, privacidade e restrições técnicas dos sites. O projeto não tenta contornar paywalls, DRM, autenticação ou outras proteções de acesso.

## Recursos

- Endpoint protegido por chave de API.
- Lista de domínios permitidos configurável.
- Limite de requisições por IP.
- Limite de tamanho e tempo de processamento.
- Resposta de download em fluxo de arquivo.
- Dockerfile para hospedagem compatível com Docker.

## Executar localmente com Docker

1. Copie `.env.example` para `.env`.
2. Troque `API_KEY` por uma chave aleatória forte. Não publique o arquivo `.env`.
3. Construa a imagem:

   ```bash
   docker build -t wentube-api .
   ```

4. Execute:

   ```bash
   docker run --rm -p 3000:3000 --env-file .env wentube-api
   ```

Verifique a saúde da API:

```bash
curl http://localhost:3000/health
```

## Endpoint

`POST /api/download`

Cabeçalhos:

- `Content-Type: application/json`
- `x-api-key: SUA_CHAVE`

Corpo:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

Exemplo com cURL, salvando a resposta como arquivo:

```bash
curl -fL -X POST "http://localhost:3000/api/download" \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_CHAVE" \
  -d '{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}' \
  -o arquivo-baixado.mp4
```

O formato real pode variar conforme a fonte e os formatos disponíveis. Erros são retornados como JSON. O endpoint `GET /health` não exige chave e serve apenas para verificar se o processo está ativo.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `API_KEY` | Obrigatória | Segredo de acesso, com pelo menos 24 caracteres |
| `PORT` | `3000` | Porta HTTP |
| `MAX_DOWNLOAD_MB` | `100` | Tamanho máximo de arquivo |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | Tempo máximo por download |
| `RATE_LIMIT_PER_MINUTE` | `5` | Requisições por minuto por IP |
| `ALLOWED_HOSTS` | `youtube.com,youtu.be` | Domínios permitidos, separados por vírgula |

## Implantar no Render

1. Crie um serviço **Web Service** e conecte este repositório.
2. Selecione **Docker** como ambiente.
3. Adicione `API_KEY` nas variáveis de ambiente do serviço, usando um segredo forte e único.
4. Configure `ALLOWED_HOSTS`, `MAX_DOWNLOAD_MB`, `DOWNLOAD_TIMEOUT_MS` e `RATE_LIMIT_PER_MINUTE` conforme a necessidade.
5. Faça o deploy e teste `https://SEU-SERVICO.onrender.com/health`.

O plano gratuito e os limites do provedor podem mudar; downloads grandes e tarefas demoradas podem não ser adequados a hospedagem gratuita. Nunca coloque a chave de API em código de frontend público.

## Limitações e segurança

- A lista de domínios é uma proteção básica, não uma garantia de que todo link do site seja seguro ou baixável.
- Mantenha Node.js, dependências e yt-dlp atualizados.
- Use HTTPS em produção.
- Não exponha a API publicamente sem uma chave forte e limites adequados.
- Para produção, considere autenticação por usuário, quotas, logs sem URLs sensíveis e limites de concorrência.
- A API não é afiliada ao NoAdsDL e não utiliza endpoints privados desse serviço.
