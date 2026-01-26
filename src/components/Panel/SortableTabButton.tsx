import React, { useCallback } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { TabButton, type TabButtonProps } from "./TabButton";

export interface SortableTabButtonProps extends TabButtonProps {
  disabled?: boolean;
}

function SortableTabButtonComponent({
  id,
  disabled = false,
  onClick,
  onClose,
  ...tabButtonProps
}: SortableTabButtonProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    setActivatorNodeRef,
  } = useSortable({
    id,
    disabled,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };

  // Wrap handlers to prevent activation of sortable when clicking or closing
  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      onClick();
    },
    [onClick]
  );

  const handleClose = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      onClose();
    },
    [onClose]
  );

  return (
    <div ref={setNodeRef} style={style} className={cn(isDragging && "opacity-50")}>
      <TabButton
        ref={setActivatorNodeRef}
        id={id}
        onClick={handleClick}
        onClose={handleClose}
        sortableListeners={listeners}
        sortableAttributes={attributes}
        {...tabButtonProps}
      />
    </div>
  );
}

export const SortableTabButton = React.memo(SortableTabButtonComponent);
