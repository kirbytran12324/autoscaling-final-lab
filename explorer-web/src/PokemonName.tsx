import {pokemonSpriteUrl} from './showdown-assets';

export function PokemonName({name, speciesId, compact = false}: {
  name: string; speciesId?: string; compact?: boolean;
}) {
  return <span className={`pokemon-name${compact ? ' pokemon-name-compact' : ''}`}>
    <img src={pokemonSpriteUrl(name, speciesId)} alt="" loading="lazy" decoding="async"
      onError={event => { event.currentTarget.hidden = true; }} />
    <span>{name}</span>
  </span>;
}
