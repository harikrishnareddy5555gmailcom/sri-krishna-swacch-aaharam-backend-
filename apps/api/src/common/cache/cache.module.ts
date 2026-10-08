import { Module, Global } from '@nestjs/common';
import { CACHE_PROVIDER } from './cache-provider.interface.js';
import { MemoryCacheProvider } from './memory-cache.provider.js';

@Global()
@Module({
  providers: [
    {
      provide: MemoryCacheProvider,
      useFactory: () => new MemoryCacheProvider(),
    },
    {
      provide: CACHE_PROVIDER,
      useExisting: MemoryCacheProvider,
    },
  ],
  exports: [CACHE_PROVIDER, MemoryCacheProvider],
})
export class CacheModule {}
