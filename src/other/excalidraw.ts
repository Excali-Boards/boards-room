import { ExcalidrawElement, OrderedExcalidrawElement, InitializedExcalidrawImageElement } from '@excalidraw/excalidraw/element/types';
import { ReconciledExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import { ElementUpdate } from '@excalidraw/excalidraw/element/mutateElement';
import { AppState } from '@excalidraw/excalidraw/types';
import { SceneBounds } from '../types.js';

export function toIterable<T>(values: readonly T[] | ReadonlyMap<string, T>): Iterable<T> {
	return Array.isArray(values) ? values : values.values();
}

export function hashElementsVersion(elements: readonly ExcalidrawElement[]): number {
	let hash = 5381;

	for (const element of toIterable(elements)) {
		hash = (hash << 5) + hash + element.versionNonce;
	}

	return hash >>> 0;
}

export const getSceneVersion = (elements: readonly ExcalidrawElement[]) => elements.reduce((acc, el) => acc + el.version, 0);

export const reconcileElements = (
	localElements: readonly ExcalidrawElement[],
	remoteElements: readonly ExcalidrawElement[],
	localAppState?: AppState,
): ReconciledExcalidrawElement[] => {
	const localElementsMap = arrayToMap(localElements);
	const reconciledElements: ExcalidrawElement[] = [];
	const added = new Set<string>();

	// process remote elements
	for (const remoteElement of remoteElements) {
		if (!added.has(remoteElement.id)) {
			const localElement = localElementsMap.get(remoteElement.id);
			const discardRemoteElement = shouldDiscardRemoteElement(
				localElement,
				remoteElement,
				localAppState,
			);

			if (localElement && discardRemoteElement) {
				reconciledElements.push(localElement);
				added.add(localElement.id);
			} else {
				reconciledElements.push(remoteElement);
				added.add(remoteElement.id);
			}
		}
	}

	// process remaining local elements
	for (const localElement of localElements) {
		if (!added.has(localElement.id)) {
			reconciledElements.push(localElement);
			added.add(localElement.id);
		}
	}

	const orderedElements = orderByFractionalIndex(reconciledElements);
	return orderedElements as ReconciledExcalidrawElement[];
};

export const arrayToMap = <T extends { id: string } | string>(
	items: readonly T[] | Map<string, T>,
) => {
	if (items instanceof Map) return items;

	return items.reduce((acc: Map<string, T>, element) => {
		acc.set(typeof element === 'string' ? element : element.id, element);
		return acc;
	}, new Map());
};

const shouldDiscardRemoteElement = (
	local: ExcalidrawElement | undefined,
	remote: ExcalidrawElement,
	localAppState?: AppState,
): boolean => {
	if (
		local &&
		(local.id === localAppState?.editingTextElement?.id ||
			local.id === localAppState?.resizingElement?.id ||
			local.id === localAppState?.newElement?.id ||
			local.version > remote.version ||
			(local.version === remote.version &&
				local.versionNonce < remote.versionNonce))
	) return true;

	return false;
};

export const orderByFractionalIndex = (elements: ExcalidrawElement[]) => {
	return elements.sort((a, b) => {
		if (isOrderedElement(a) && isOrderedElement(b)) {
			if (a.index < b.index) return -1;
			else if (a.index > b.index) return 1;

			return a.id < b.id ? -1 : 1;
		}

		return 1;
	});
};

const isOrderedElement = (element: ExcalidrawElement): element is OrderedExcalidrawElement => {
	if (element.index) return true;
	return false;
};

export const getVisibleSceneBounds = ({
	scrollX,
	scrollY,
	width,
	height,
	zoom,
}: AppState): SceneBounds => {
	return [
		-scrollX,
		-scrollY,
		-scrollX + width / zoom.value,
		-scrollY + height / zoom.value,
	];
};

export const isInitializedImageElement = (
	element: ExcalidrawElement | null,
): element is InitializedExcalidrawImageElement => {
	return !!element && element.type === 'image' && !!element.fileId;
};

export const newElementWith = <TElement extends ExcalidrawElement>(
	element: TElement,
	updates: ElementUpdate<TElement>,
	force = false,
): TElement => {
	let didChange = false;
	for (const key in updates) {
		const value = updates[key as keyof typeof updates];

		if (typeof value !== 'undefined') {
			if (element[key as keyof TElement] === value && (typeof value !== 'object' || value === null)) continue;
			didChange = true;
		}
	}

	if (!didChange && !force) return element;

	return {
		...element,
		...updates,
		updated: Date.now(),
		version: element.version + 1,
		versionNonce: Math.floor(Math.random() * 0x100000000),
	};
};
