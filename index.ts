import {Elysia} from 'elysia'

function normalizeHost(request: Request) {
  return (request.headers.get('host') ?? '')
    .toLowerCase()
    .replace(/:\d+$/, '')
}

var server = new Elysia()
  .onRequest(async (req) => {
    const host = normalizeHost(req.request)
    const app = (await import(`./modules/${host}.ts`)).app as Elysia
    return app.handle(req.request)
  })


server.listen(3000)
