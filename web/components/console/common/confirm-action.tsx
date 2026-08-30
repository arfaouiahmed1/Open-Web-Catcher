"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogActionButton,
  AlertDialogCancelButton,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export interface ConfirmActionProps {
  trigger: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actionLabel: React.ReactNode;
  onConfirm?: () => void | Promise<void>;
  actionVariant?: "default" | "danger" | "accent" | "outline" | "ghost";
}

export const ConfirmAction = React.memo(function ConfirmAction({
  trigger,
  title,
  description,
  actionLabel,
  onConfirm,
  actionVariant = "danger",
}: ConfirmActionProps): React.JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancelButton>Cancel</AlertDialogCancelButton>
          <AlertDialogActionButton variant={actionVariant} onClick={onConfirm}>
            {actionLabel}
          </AlertDialogActionButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
});
