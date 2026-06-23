import './register-paths';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody habilita a verificação de assinatura do webhook da Meta.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.setGlobalPrefix('api');

  // CORS por env.
  const origins = new Set<string>([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ]);
  const frontendUrl = process.env.FRONTEND_URL?.trim().replace(/\/$/, '');
  if (frontendUrl) origins.add(frontendUrl);
  (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .forEach((o) => origins.add(o));

  app.enableCors({
    origin: (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || origins.has(origin.replace(/\/$/, ''))) {
        return cb(null, true);
      }
      return cb(new Error('Origem não permitida pelo CORS'), false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Guards globais (JWT → ConnectedAccount) são registrados via APP_GUARD no
  // AppModule, garantindo a ordem correta (req.user populado antes do segundo).

  const swaggerConfig = new DocumentBuilder()
    .setTitle('InstaAuto API')
    .setDescription('Backend de automação de Instagram/Facebook')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}
void bootstrap();
