/* eslint-disable stack/naming-convention -- decorator factories are PascalCase by convention */
// Local stand-ins for @nestjs/common decorators so the fixture has no
// dependency on Nest packages.
export function Injectable(): ClassDecorator {
	return () => undefined;
}

export function Optional(): ParameterDecorator {
	return () => undefined;
}
