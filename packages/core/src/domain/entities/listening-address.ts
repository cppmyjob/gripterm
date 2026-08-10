import { ValidationError } from '../errors/gripterm-error';

/**
 * The one host this extension ever listens on. Fixed rather than passed in:
 * an address is written verbatim into `settings.json`, and a file that told
 * Claude Code to POST a conversation's events at a non-loopback interface
 * would publish them to the network -- a mistake that no test downstream of
 * the value could catch, because everything downstream would still work.
 */
const LOOPBACK_HOST = '127.0.0.1';

/** 16 bits, and port 0 is not among the usable ones -- see `loopback`. */
const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Where this window's hook server can be reached.
 *
 * It exists as a value rather than a bare number because of an asymmetry
 * measured in the CLI: `$VAR` interpolation applies to hook HEADER values only,
 * never to the URL [binary 2.1.224], so the port cannot be handed to the CLI
 * through the environment and has to be a literal inside the settings file.
 * That makes the address part of a written artefact, and the artefact is
 * regenerated per activation -- so the value the file was built from is worth
 * having in one place with its invariants attached.
 */
export class ListeningAddress {
  private constructor(
    public readonly host: string,
    public readonly port: number
  ) {
    Object.freeze(this);
  }

  public get origin(): string {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * `port` is the port a server has ALREADY bound, so 0 is refused rather than
   * treated as "ephemeral". Passing 0 to `listen` asks the OS to choose; reading
   * 0 back means nothing was chosen yet, and a settings file naming port 0 is an
   * observation channel that is dead on arrival while looking perfectly ordinary.
   */
  public static loopback(port: number): ListeningAddress {
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw new ValidationError(`port must be an integer between ${MIN_PORT} and ${MAX_PORT}`, {
        details: { port },
      });
    }
    return new ListeningAddress(LOOPBACK_HOST, port);
  }

  public equals(other: ListeningAddress): boolean {
    return this.host === other.host && this.port === other.port;
  }
}
